// Forwarding a tenant's request to the workload (spec §12).
//
// Plain HTTP/1.1, and deliberately plain. Two things about it are protocol
// rather than taste:
//
//   - `Host` is PRESERVED. The application is reached at a hostname the
//     gateway owns, but what it must see is the name the tenant used: a
//     framework that builds absolute URLs, sets a cookie domain or matches a
//     virtual host from `Host` would otherwise answer with the workload's
//     private address. The gateway's own name never appears in `Host`.
//   - The three `X-Forwarded-*` headers are SET, so the application knows the
//     request came through a gateway and can tell who sent it: `-For` the
//     tenant's address, `-Proto` the scheme the tenant actually used (which is
//     `https` where TLS was terminated here, whatever this hop is), `-Host`
//     the same name as `Host`, which is the header a framework trusts when it
//     has been taught that `Host` may have been rewritten.
//
// Hop-by-hop headers are not forwarded, in either direction (RFC 9110 §7.6.1):
// they belong to one connection, and this is two.
//
// A WebSocket upgrade is passed through as the same proxy, one layer lower: the
// handshake is replayed to the workload and the two sockets are then joined, so
// an application that holds a connection open keeps working behind a gateway.

import { request as httpRequest } from 'node:http';

import { connectionOptions, refusalFor } from './dial.mjs';
import { unavailable } from './reasons.mjs';

/** Headers that belong to one hop and are never copied to the next. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/** `::ffff:127.0.0.1` is the same address as `127.0.0.1`; say it the short way. */
const plainAddress = (address) =>
  typeof address === 'string' ? address.replace(/^::ffff:/i, '') : undefined;

/**
 * The headers to send onward: everything the tenant sent, minus this hop's,
 * plus what says the request came through a gateway.
 */
export function forwardedHeaders(req, { secure, keep = [] }) {
  /** @type {Record<string, any>} */
  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (HOP_BY_HOP.has(name) && !keep.includes(name)) continue;
    headers[name] = value;
  }

  // The `Host` a tenant used, preserved — and repeated in `X-Forwarded-Host`,
  // the header a framework behind a proxy is configured to read.
  const host = req.headers.host;
  if (host !== undefined) headers['x-forwarded-host'] = host;
  headers['x-forwarded-proto'] = secure ? 'https' : 'http';

  const client = plainAddress(req.socket?.remoteAddress);
  const already = req.headers['x-forwarded-for'];
  const chain = [already, client].filter((part) => part !== undefined && part !== '');
  if (chain.length > 0) headers['x-forwarded-for'] = chain.join(', ');

  return headers;
}

/** Everything the upstream answered, minus the headers that belong to its hop. */
const answeredHeaders = (answer) =>
  Object.fromEntries(Object.entries(answer.headers).filter(([name]) => !HOP_BY_HOP.has(name)));

/**
 * A settle-once callback.
 *
 * A forwarding attempt can end several ways at once — the workload resets
 * while the tenant hangs up — and the tenant must be answered once. `done()`
 * says whether that has happened, which is also how the keep-alive pool
 * survives: a connection is only destroyed when the attempt had not finished.
 */
const settleOnce = (resolve) => {
  let settled = false;
  const finish = (outcome) => {
    if (settled) return;
    settled = true;
    resolve(outcome);
  };
  finish.done = () => settled;
  return finish;
};

/**
 * The refusal a workload that will not answer becomes — or, for a dial this
 * gateway would not make at all, the refusal saying why not.
 */
const unreachable = (target, workloadId, e) =>
  refusalFor(e, workloadId) ??
  unavailable('member_unreachable', {
    workloadId,
    member: target.member,
    address: `${target.host}:${target.port}`,
    why: e instanceof Error ? e.message : String(e),
  });

/**
 * Forward one ordinary request, and answer the tenant with what came back.
 *
 * @param {{
 *   req: import('node:http').IncomingMessage,
 *   res: import('node:http').ServerResponse,
 *   target: { host: string, port: number, member?: string },
 *   workloadId: string,
 *   secure: boolean,
 *   connect?: import('./dial.mjs').Dial,
 *   agent?: import('node:http').Agent,
 * }} context
 */
export function forwardRequest({ req, res, target, workloadId, secure, connect, agent }) {
  return new Promise((resolve) => {
    const finish = settleOnce(resolve);

    let upstream;
    try {
      upstream = httpRequest({
        host: target.host,
        port: target.port,
        path: req.url,
        method: req.method,
        headers: forwardedHeaders(req, { secure }),
        ...connectionOptions(connect, target.host, target.port, agent),
      });
    } catch (e) {
      finish({ unavailable: unreachable(target, workloadId, e) });
      return;
    }

    upstream.on('response', (answer) => {
      res.writeHead(answer.statusCode ?? 502, answeredHeaders(answer));
      answer.pipe(res);
      answer.on('end', () => finish({ served: true }));
      answer.on('error', () => {
        res.destroy();
        finish({ served: true });
      });
    });

    // A workload that will not answer is the tenant's `member_unreachable` —
    // unless the answer had already started, when there is no longer anywhere
    // to say it and ending the response is the only honest thing left.
    upstream.on('error', (e) => finish({ unavailable: unreachable(target, workloadId, e) }));
    // A tenant that hung up mid-answer: drop the upstream with it. A response
    // that FINISHED closes too, and that connection belongs to the pool.
    res.on('close', () => {
      if (!finish.done()) upstream.destroy();
      finish({ served: true });
    });

    req.pipe(upstream);
    req.on('error', () => upstream.destroy());
  });
}

/** The handshake bytes an upgraded response is, written back to the tenant. */
const handshake = (answer) => {
  const reason = answer.statusMessage ? ` ${answer.statusMessage}` : '';
  const lines = [`HTTP/1.1 ${answer.statusCode}${reason}`];
  for (let i = 0; i < answer.rawHeaders.length; i += 2) {
    lines.push(`${answer.rawHeaders[i]}: ${answer.rawHeaders[i + 1]}`);
  }
  return `${lines.join('\r\n')}\r\n\r\n`;
};

/**
 * Forward one upgrade, and then join the two connections.
 *
 * @param {{
 *   req: import('node:http').IncomingMessage,
 *   socket: import('node:stream').Duplex,
 *   head?: Buffer,
 *   target: { host: string, port: number, member?: string },
 *   workloadId: string,
 *   secure: boolean,
 *   connect?: import('./dial.mjs').Dial,
 * }} context
 */
export function forwardUpgrade({ req, socket, head, target, workloadId, secure, connect }) {
  return new Promise((resolve) => {
    const finish = settleOnce(resolve);

    let upstream;
    try {
      upstream = httpRequest({
        host: target.host,
        port: target.port,
        path: req.url,
        method: req.method,
        // `connection` and `upgrade` are hop-by-hop, and this is the one
        // request where they ARE the request: the handshake is what is proxied.
        headers: forwardedHeaders(req, { secure, keep: ['connection', 'upgrade'] }),
        // Never pooled: this socket is about to be hijacked, and must not go
        // back into a pool that another request would then be given.
        ...connectionOptions(connect, target.host, target.port, undefined),
      });
    } catch (e) {
      finish({ unavailable: unreachable(target, workloadId, e) });
      return;
    }

    upstream.on('upgrade', (answer, upstreamSocket, upstreamHead) => {
      socket.write(handshake(answer));
      if (upstreamHead?.length) socket.write(upstreamHead);
      if (head?.length) upstreamSocket.write(head);
      upstreamSocket.on('error', () => socket.destroy());
      socket.on('error', () => upstreamSocket.destroy());
      socket.pipe(upstreamSocket);
      upstreamSocket.pipe(socket);
      finish({ served: true });
    });

    // An upstream that answered without upgrading did not accept the
    // handshake. That answer is the tenant's, verbatim: a workload that says
    // `426` about its own protocol is not a gateway failure.
    upstream.on('response', (answer) => {
      socket.write(handshake(answer));
      answer.pipe(socket);
      answer.on('end', () => finish({ served: true }));
      // `pipe` does not carry an error across: a workload that resets
      // mid-answer would otherwise be an uncaught error, and this process is
      // still serving every other workload.
      answer.on('error', () => {
        socket.destroy();
        finish({ served: true });
      });
    });

    upstream.on('error', (e) => finish({ unavailable: unreachable(target, workloadId, e) }));
    socket.on('close', () => {
      if (!finish.done()) upstream.destroy();
      finish({ served: true });
    });

    upstream.end();
  });
}
