// Asking one Standby Set member where the workload is (spec §6.5).
//
// This is the whole of what a Gateway Grant buys, and it is also how a grant
// is PROVEN: a gateway cannot check a handover against a signature, so it
// sends one of these and sees whether the member takes it (`src/admit.mjs`).
//
// The request is an ordinary Lease Request (spec §6.1) and nobody signs it: a
// plain JSON object naming one provider, with the derived grant riding in
// `continuation` exactly where the lease's own token would ride, and the
// moment it was derived for named in the content's `gateway_expires_at`
// (§6.5.1). The provider recomputes the grant from the token it already
// stores and answers the gateway exactly what it would have answered the
// tenant. `request_id` is 32 fresh random bytes, which is what the provider's
// replay set keys on, so every request is new even when the grant is not.
//
// THE GRANT IS A SECRET. It is what authority this gateway has, so it goes to
// the members the handover names and nowhere else: never into a log line,
// never into an error message, and never into an answer this gateway writes.
//
// CARRIAGE — a decision worth knowing about. `status` is a FREE route (spec
// §5), so there is no payment to make and no claim to attach, and this gateway
// holds no channel, no mnemonic and no wallet: it must never call a paid
// route. What it sends is therefore the §6.1.2 packet body — `{ "request":
// <request> }` — over plain HTTP to the member's connector at the `status`
// path, which is the body a provider reads after its connector has unsealed
// the envelope and the path the wire fixtures record as `http_path`.
//
// A deployment whose members sit behind a connector that terminates the sealed
// ILP envelope needs that carriage instead, and ONLY this module changes: the
// request and the grant are identical either way — what changes is the
// carriage, not the request. That swap is not made here because it would buy
// nothing (the route is free), would need the connector's self-description and
// sealing key, and would put a payment client into a process whose whole point
// is that it holds none.

import { randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

import { connectionOptions } from './dial.mjs';

/** Where a connector forwards `<addr>.status` (spec §5; the provider's `STATUS_PATH`). */
export const STATUS_PATH = '/status';

/** The request window of §6.1: a provider refuses one older than its `expiration`. */
export const REQUEST_TTL_S = 60;

/**
 * The `status` a gateway sends one member, presenting its Gateway Grant.
 *
 * @param {{
 *   member: string, workloadId: string, grant: string,
 *   gatewayExpiresAt: number, now: number, ttlS?: number,
 * }} options
 */
export function statusRequest({ member, workloadId, grant, gatewayExpiresAt, now, ttlS = REQUEST_TTL_S }) {
  return {
    request_id: randomBytes(32).toString('hex'),
    op: 'status',
    provider: member,
    expiration: now + ttlS,
    continuation: grant,
    content: { workload_id: workloadId, gateway_expires_at: gatewayExpiresAt },
  };
}

/**
 * The URL a member's `status` is sent to, from its Profile's `connector_url`.
 *
 * `connector_url` is a location hint (spec §4.1) and conventionally ends in
 * `/ilp` — the connector's own client edge. The route beside it is where
 * `<addr>.status` lands, so the `/ilp` suffix is replaced rather than appended
 * to, and a connector published without one is simply asked at its root.
 */
export function statusUrl(connectorUrl) {
  const url = new URL(connectorUrl);
  url.search = '';
  url.hash = '';
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = (path.toLowerCase().endsWith('/ilp') ? path.slice(0, -4) : path) + STATUS_PATH;
  return url;
}

/**
 * Send one `status` and read the answer.
 *
 * Resolves with `{ status, body }` — the provider's refusal shape included,
 * because a refusal is an answer: a member that says `bad_grant` has been
 * reached and is simply not the target. It REJECTS only when the member could
 * not be reached or did not answer in time, which is the difference between
 * "no member is running it" and "this member cannot be reached".
 *
 * @param {{
 *   connectorUrl: string, request: object, timeoutMs: number,
 *   connect?: import('./dial.mjs').Dial,
 * }} options
 * @returns {Promise<{ status: number | undefined, body: any }>}
 */
export function askStatus({ connectorUrl, request, timeoutMs, connect }) {
  const url = statusUrl(connectorUrl);
  const secure = url.protocol === 'https:';
  const send = secure ? httpsRequest : httpRequest;
  const payload = JSON.stringify({ request });
  const port = Number(url.port || (secure ? 443 : 80));

  return new Promise((resolve, reject) => {
    // Never pooled: a `status` is asked rarely, and a connection left open in
    // a pool would outlive the gateway's own shutdown.
    let dialled;
    try {
      dialled = connectionOptions(connect, url.hostname, port, undefined, { secure });
    } catch (e) {
      reject(e);
      return;
    }

    const outbound = send(
      {
        host: url.hostname,
        port,
        path: url.pathname,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(payload)),
          accept: 'application/json',
        },
        ...dialled,
      },
      (answer) => {
        const chunks = [];
        answer.on('data', (chunk) => chunks.push(chunk));
        answer.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let body = null;
          try {
            body = JSON.parse(text || 'null');
          } catch {
            reject(new Error(`answered ${answer.statusCode} with something that is not JSON`));
            return;
          }
          resolve({ status: answer.statusCode, body });
        });
      },
    );

    outbound.setTimeout(timeoutMs, () => {
      outbound.destroy(new Error(`did not answer \`status\` within ${timeoutMs} ms`));
    });
    outbound.on('error', reject);
    outbound.end(payload);
  });
}
