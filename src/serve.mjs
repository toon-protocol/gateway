// Answering a request: which workload this hostname is, and what to say when
// it cannot be served (spec §12).
//
// The whole of this ticket's request path is here, and it deliberately stops
// one step short of the workload: finding WHERE a granted workload runs, and
// forwarding to it, is the resolver's job (M5-4), and the resolver is passed
// in. What is decided here is what is decided the same way for every gateway:
// a hostname is one label under this gateway's domain, that label is a
// workload this gateway holds a grant for, and the grant is in force.
//
// A hostname that is none of those is answered 503 by the gateway itself and
// NOTHING is dialled: no provider is asked about a workload nobody granted.

import { labelUnder } from './hostname.mjs';
import { renderUnavailable, unavailable } from './reasons.mjs';

/**
 * @typedef {{ reason: string, status: number, message: string }} Unavailable
 */

/**
 * What to do with a request whose hostname names a workload this gateway holds
 * a grant for. M5-4 is what fills it in.
 *
 * Returning `{ unavailable }` answers the error page. Returning ANYTHING else,
 * nothing included, means the resolver answered the request itself.
 *
 * @typedef {(context: {
 *   grant: ReturnType<typeof import('./grant.mjs').readGrant>,
 *   req: import('node:http').IncomingMessage,
 *   res?: import('node:http').ServerResponse,
 *   socket?: import('node:stream').Duplex,
 *   head?: Buffer,
 *   secure: boolean,
 * }) => Promise<{ unavailable: Unavailable } | any>} Resolver
 */

/**
 * The grant a request's Host names, or why there is none to serve.
 *
 * @returns {{ grant: object } | { unavailable: { reason: string, status: number, message: string } }}
 */
export function grantForHost(host, { domain, grants, now }) {
  const label = labelUnder(host, domain);
  const grant = label === null ? undefined : grants.find(label);
  if (grant === undefined) {
    return { unavailable: unavailable('no_grant', { host: host ?? '(no Host header)' }) };
  }
  if (!grant.inForceAt(now())) {
    return {
      unavailable: unavailable('grant_expired', {
        workloadId: grant.workloadId,
        expiresAt: grant.expiresAt,
      }),
    };
  }
  return { grant };
}

/** The resolver this gateway runs with until M5-4 gives it a real one. */
export const notResolved = async ({ grant }) => ({
  unavailable: unavailable('not_resolved', { workloadId: grant.workloadId }),
});

/**
 * Write one refusal as an ordinary HTTP response.
 *
 * A resolver that failed AFTER it had begun answering leaves nothing to say a
 * refusal in: the tenant has already been sent a status line. Ending the
 * response is then the only honest thing, and a truncated body is what a
 * reverse proxy gives in that position anyway.
 */
/**
 * The headers of a refusal.
 *
 * `toon-gateway-reason` is there so a machine reading the answer needs no body
 * parser, and so a log line through a CDN still says which reason it was.
 */
const refusalHeaders = (why, rendered) => ({
  'content-type': rendered.contentType,
  'content-length': String(Buffer.byteLength(rendered.body)),
  'toon-gateway-reason': why.reason,
  connection: 'close',
});

export function answerUnavailable(res, why, accept) {
  if (res.headersSent) {
    res.end();
    return;
  }
  const rendered = renderUnavailable(why, accept);
  res.writeHead(rendered.status, refusalHeaders(why, rendered));
  res.end(rendered.body);
}

/** Write one refusal onto a socket that asked to be upgraded. */
export function refuseUpgrade(socket, why) {
  if (!socket.writable) {
    socket.destroy();
    return;
  }
  const rendered = renderUnavailable(why, '*/*');
  const headers = Object.entries(refusalHeaders(why, rendered))
    .map(([name, value]) => `${name}: ${value}\r\n`)
    .join('');
  socket.end(`HTTP/1.1 ${rendered.status} Service Unavailable\r\n${headers}\r\n${rendered.body}`);
}

/**
 * The gateway's request path.
 *
 * @param {{
 *   domain: string,
 *   grants: { find: (label: string) => object | undefined },
 *   resolve?: Resolver,
 *   now?: () => number,
 *   log?: (line: string) => void,
 * }} deps
 */
export function createRequestHandler({
  domain,
  grants,
  resolve = notResolved,
  now = () => Math.floor(Date.now() / 1000),
  log = () => {},
}) {
  const serve = async (context, refuse) => {
    const found = grantForHost(context.req.headers.host, { domain, grants, now });
    if ('unavailable' in found) {
      refuse(found.unavailable);
      return;
    }
    try {
      const outcome = await resolve({ ...context, grant: found.grant });
      if (outcome?.unavailable !== undefined) refuse(outcome.unavailable);
    } catch (e) {
      // A resolver that threw is a gateway fault, not a tenant's: say so
      // rather than dropping the connection, so it is tellable apart from a
      // workload that is not running.
      log(`resolving ${found.grant.workloadId} threw: ${e instanceof Error ? e.stack : String(e)}`);
      refuse(unavailable('not_resolved', { workloadId: found.grant.workloadId }));
    }
  };

  return {
    /** An ordinary HTTP request. */
    handleRequest(req, res, { secure = false } = {}) {
      return serve({ req, res, secure }, (why) => {
        log(`${req.headers.host ?? '-'} ${req.method} ${req.url}: ${why.reason}`);
        answerUnavailable(res, why, req.headers.accept);
      });
    },

    /** A WebSocket upgrade. M5-4 passes these through to the workload. */
    handleUpgrade(req, socket, head, { secure = false } = {}) {
      return serve({ req, socket, head, secure }, (why) => {
        log(`${req.headers.host ?? '-'} UPGRADE ${req.url}: ${why.reason}`);
        refuseUpgrade(socket, why);
      });
    },
  };
}
