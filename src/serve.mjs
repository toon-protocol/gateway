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

/** Write one refusal as an ordinary HTTP response. */
export function answerUnavailable(res, why, accept) {
  const rendered = renderUnavailable(why, accept);
  res.writeHead(rendered.status, {
    'content-type': rendered.contentType,
    'content-length': Buffer.byteLength(rendered.body),
    // So a machine reading the answer needs no body parser, and a log line
    // through a CDN still says which reason it was.
    'toon-gateway-reason': why.reason,
    connection: 'close',
  });
  res.end(rendered.body);
}

/** Write one refusal onto a socket that asked to be upgraded. */
export function refuseUpgrade(socket, why) {
  const rendered = renderUnavailable(why, '*/*');
  socket.end(
    `HTTP/1.1 ${rendered.status} Service Unavailable\r\n` +
      `content-type: ${rendered.contentType}\r\n` +
      `content-length: ${Buffer.byteLength(rendered.body)}\r\n` +
      `toon-gateway-reason: ${why.reason}\r\n` +
      'connection: close\r\n\r\n' +
      rendered.body,
  );
}

/**
 * The gateway's request path.
 *
 * @param {{
 *   domain: string,
 *   grants: { find: (label: string) => object | undefined },
 *   resolve?: Function,
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
      if (outcome !== undefined && 'unavailable' in outcome) refuse(outcome.unavailable);
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
