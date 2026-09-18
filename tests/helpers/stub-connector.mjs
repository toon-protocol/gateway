// A provider's connector, in process: it answers `status` the way a provider
// does (spec §6.5), and records every request it was sent.
//
// This is the seam M5-4 drives resolution against: one stub per Standby Set
// member, each told what to answer — `running` with `access`, `reserved`,
// `stopped`, an ending, an error, or nothing at all. A member that answers
// anything but `running` is simply not the target, and a member that answers
// nothing is unreachable; both are ordinary here.
//
// It speaks plain HTTP `POST /status` with `{ "request": <request> }`, which
// is the body a provider reads after its connector has unsealed the envelope
// (spec §6.1.2) and the shape the wire fixtures record as `http_path`. The
// request is a plain JSON object that nobody signed, carrying the gateway's
// Gateway Grant as its `continuation` and the moment it was derived for as
// its content's `gateway_expires_at` (§6.5.1).
//
// A gateway that later buys its `status` through an ILP connector sends the
// same body; what changes is the carriage, not the request.

import { createServer } from 'node:http';

import { peerOf } from './peer.mjs';

/** `{ "error", "message" }` — the refusal shape of every route (spec §5). */
export const refusal = (error, message) => ({ error, message });

/** The usual answer of a member that runs the workload (spec §6.5). */
export const running = ({ workloadId, host = '127.0.0.1', ports = [], sshPort = 40000, expiresAt = 1700003600, role = 'standalone', extra = {} }) => ({
  workload_id: workloadId,
  role,
  state: 'running',
  expires_at: expiresAt,
  access: { host, ssh_port: sshPort, ports },
  ...extra,
});

/**
 * @param {{
 *   pubkey?: string,
 *   answer?: (context: { workloadId: string, request: any, continuation: any, gatewayExpiresAt: any, body: any }) => object | undefined,
 *   silent?: boolean,
 * }} [options]
 *   `answer` returns the JSON body to send; returning `undefined` means the
 *   member answers `unknown_workload`. `silent` means it accepts the
 *   connection and never replies — a member that cannot be reached in time.
 */
export async function startStubConnector({ pubkey, answer, silent = false } = {}) {
  /** @type {{ path: string, body: any, request: any, content: any, continuation: any, gatewayExpiresAt: any, peer: { address: string, port: number } }[]} */
  const requests = [];
  let respond = answer ?? (() => undefined);
  let quiet = silent;

  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      let body = null;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null');
      } catch {
        /* recorded as null below */
      }
      const request = body?.request;
      const content = request?.content ?? null;
      requests.push({
        path: req.url ?? '',
        body,
        request,
        content,
        /** The Gateway Grant the gateway presented, where a token would ride. */
        continuation: request?.continuation,
        gatewayExpiresAt: content?.gateway_expires_at,
        // Who connected: a gateway directly, or a proxy on its behalf (M5-6).
        peer: peerOf(req),
      });

      if (quiet) return; // connected, and never answered.

      const answered =
        respond({
          workloadId: content?.workload_id,
          request,
          continuation: request?.continuation,
          gatewayExpiresAt: content?.gateway_expires_at,
          body,
        }) ?? refusal('unknown_workload', 'this provider never leased that workload id');
      const payload = JSON.stringify(answered);
      res.writeHead(answered.error === undefined ? 200 : 403, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(payload),
      });
      res.end(payload);
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const { port } = /** @type {{ port: number }} */ (server.address());

  return {
    /** The provider whose connector this is, for its Profile and `standby_set`. */
    pubkey,
    host: '127.0.0.1',
    port,
    /** What a Provider Profile's `connector_url` points at (spec §4.1). */
    url: `http://127.0.0.1:${port}`,

    /** Every request this connector was sent, parsed. */
    get requests() {
      return [...requests];
    },

    /** Change what it answers, mid-test. */
    answerWith(next) {
      respond = next;
    },

    /** Stop answering (a member that goes unreachable), or start again. */
    goSilent(value = true) {
      quiet = value;
    },

    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve(undefined)));
    },
  };
}
