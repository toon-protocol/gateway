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
// CARRIAGE — the sealed packet, exactly as every other client of that route
// sends one (spec §5, §6.1.2; ADR 0011, ADR 0022). What a member must RECEIVE
// is `{ "request": <request> }`; how it gets there is its connector's
// question, and the Provider Profile answers it in three fields and no
// guesswork: the packet is addressed `<ilp_address>.status`, sent to
// `connector_url`, and sealed to `connector_seal_key`. The connector unseals
// it and forwards plain HTTP to the provider app, which reads the body as
// plaintext JSON and no payment header (§2).
//
// WHY NOT A PATH BESIDE `connector_url`. An earlier round of this module
// replaced the `/ilp` suffix of `connector_url` with `/status` and sent plain
// HTTP there. That URL is nowhere in the directory: `connector_url` is the
// connector's own client edge (§4.1), and the provider app's listener carries
// `/status` AND every `<listing>.v<n>.spawn` handler, so a deployment that
// published it would be putting a paid route on the public internet with the
// payment skipped. Real deployments therefore 404 it, and a 404 is not an
// answer about a lease — which is how every handover to a connector-fronted
// provider came to be answered `no_running_member` (TOON_Network#114).
//
// THIS GATEWAY STILL HOLDS NO MONEY. `status` is priced at 0 (§5), and a free
// route needs no claim: the identity below is generated fresh at startup, is
// written to no store and holds no channel, and `autoOpenChannel` is off — so
// a paid route cannot be paid for here even by mistake, which is a stronger
// statement than "this gateway is careful". The key exists because a sealed
// packet needs an ephemeral sender, not because anything is bought with it.

import { randomBytes } from 'node:crypto';

import { generateRandomIdentity } from '@toon-protocol/client';

import { isAnyoneHost, NoProxyError } from './dial.mjs';
import { rewriteTarget } from './rewrite.mjs';

/** The route a member's free `status` is terminated at (spec §5). */
export const STATUS_ROUTE = 'status';

/** The request window of §6.1: a provider refuses one older than its `expiration`. */
export const REQUEST_TTL_S = 60;

/** The `status` route of one member: `<ilp_address>.status` (spec §5). */
export const statusDestination = (ilpAddress) => `${ilpAddress}.${STATUS_ROUTE}`;

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

/** A pinned `connector_seal_key` as the bytes the connector client seals to. */
const sealKeyBytes = (hex) => Uint8Array.from(Buffer.from(hex.replace(/^0x/i, ''), 'hex'));

/** The first few hundred characters of whatever a member sent, for a log line. */
const snippet = (text) => {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > 120 ? `${flat.slice(0, 117)}...` : flat;
};

/**
 * Where a member's connector is DIALLED, which is where it says it is unless
 * this gateway has been told otherwise (`src/rewrite.mjs`).
 *
 * The rewrite is the same table the forwarding leg uses, applied to the URL
 * rather than to the socket, because this leg's socket belongs to the
 * connector client. It moves where the bytes go and nothing else: the
 * destination addressed, the key sealed to and the request itself are all
 * untouched.
 */
export function dialledConnector(connectorUrl, rewrites) {
  const url = new URL(connectorUrl);
  const secure = url.protocol === 'https:';
  const port = Number(url.port || (secure ? 443 : 80));
  const to = rewriteTarget(rewrites, url.hostname, port);
  if (to.host === url.hostname && to.port === port) return connectorUrl;
  url.hostname = to.host;
  url.port = String(to.port);
  return url.toString();
}

/**
 * The connector clients this gateway sends `status` through.
 *
 * ONE CLIENT PER CONNECTOR, kept: building one reads the connector's
 * self-description (`GET /ilp`), and a gateway that rebuilt it per request
 * would ask a member twice for every `status` and hold a cache of nothing.
 * `close()` ends them all, so a shutdown leaves no socket behind.
 *
 * The identity is generated ONCE for this process and shared by every client:
 * it is not an account, nothing is settled with it, and it exists only so a
 * gift-wrapped packet has a sender. Both chains' keys are generated because
 * which chain a member's connector settles on is the member's business, and a
 * client that holds no key for it refuses to be built at all.
 *
 * @param {{
 *   socksProxy?: string,
 *   rewrites?: Map<string, { host: string, port: number | undefined }>,
 *   timeoutMs: number,
 *   log?: (line: string) => void,
 *   createClient?: (config: object) => Promise<any>,
 * }} deps
 */
export function createConnectors({
  socksProxy,
  rewrites = new Map(),
  timeoutMs,
  log = () => {},
  createClient,
}) {
  /** @type {Map<string, Promise<any>>} connector URL -> its client */
  const clients = new Map();
  /** Generated on first use, so a gateway that never resolves anything makes no key. */
  let identity;

  const open = async (connectorUrl) => {
    const { ToonClient } = await import('@toon-protocol/client');
    identity ??= generateRandomIdentity();
    const dialled = dialledConnector(connectorUrl, rewrites);
    if (dialled !== connectorUrl) log(`asking ${connectorUrl} at ${dialled} (GATEWAY_DIAL_REWRITE)`);
    const config = {
      connector: dialled,
      evmPrivateKey: identity.evm.privateKey,
      solanaSecretKey: identity.solana.secretKey,
      // `status` is free, so there is nothing to pay and nothing to open a
      // channel for. Off, rather than merely unused: a bug that addressed a
      // paid route here fails loudly instead of quietly buying something.
      autoOpenChannel: false,
      deposit: 0n,
      // One-shot and stateless, which is what a `status` is.
      transport: /** @type {'http'} */ ('http'),
      timeoutMs,
      // THE PROXY IS FOR `.anyone` HOSTS AND NOTHING ELSE (spec §12.8): a
      // member at a hidden address is reached through the anon client, and
      // any other member is dialled directly — so a Standby Set mixing the
      // two needs no configuration beyond the proxy, and a public member is
      // not quietly routed through a circuit it never asked for. The client
      // refuses the pairing outright, which is the same rule said twice.
      ...(socksProxy !== undefined && isAnyoneHost(new URL(dialled).hostname) ? { socksProxy } : {}),
    };
    return createClient === undefined ? ToonClient.create(config) : createClient(config);
  };

  const clientFor = (connectorUrl) => {
    const held = clients.get(connectorUrl);
    if (held !== undefined) return held;
    // A failure to build is not cached: a connector that was down when this
    // gateway first asked must be askable again on the next request.
    const opening = open(connectorUrl).catch((e) => {
      clients.delete(connectorUrl);
      throw e;
    });
    clients.set(connectorUrl, opening);
    return opening;
  };

  /**
   * One ask, with no deadline of its own: what the race below is racing.
   *
   * @param {{ profile: { connectorUrl: string, ilpAddress: string, connectorSealKey: string }, request: object }} options
   * @returns {Promise<{ status: number | undefined, body: any, text: string }>}
   */
  const asked = async ({ profile, request }) => {
    const url = new URL(profile.connectorUrl);
    // An `.anyone` connector is never resolved or dialled directly (spec
    // §12.8): with no proxy, nothing is tried and the tenant is told so by
    // name. The client would refuse it too, but this refusal is the one the
    // reason vocabulary already has a word for.
    if (isAnyoneHost(url.hostname) && socksProxy === undefined) {
      throw new NoProxyError(url.hostname, Number(url.port || (url.protocol === 'https:' ? 443 : 80)));
    }
    const client = await clientFor(profile.connectorUrl);
    const destination = statusDestination(profile.ilpAddress);
    const sent = await client.send(
      destination,
      { body: { request } },
      { sealTo: sealKeyBytes(profile.connectorSealKey), timeoutMs },
    );
    // A REJECT is the CARRIAGE refusing, not the provider answering: no
    // route, a price this gateway will not pay, a seal the connector could
    // not open. Nothing was learned about the lease.
    if (!sent.fulfilled) {
      throw new Error(
        `${destination} was refused by ${sent.refusedBy ?? 'the path'}: ${sent.code} ${sent.message}`,
      );
    }
    const text = sent.text();
    let body;
    try {
      body = JSON.parse(text || 'null') ?? undefined;
    } catch {
      body = undefined;
    }
    return { status: sent.status, body, text: snippet(text) };
  };

  return {
    /**
     * Send one `status` to one member, and read the answer.
     *
     * Resolves with `{ status, body, text }` — the provider's refusal shape
     * included, because a refusal is an answer: a member that says `bad_grant`
     * has been reached and is simply not the target. `body` is the JSON the
     * member sent, or `undefined` when what came back was not JSON at all;
     * `text` is what it sent instead, for a log line.
     *
     * It REJECTS only when the member could not be reached, was refused
     * carriage, or did not answer in time — which is the difference between
     * "no member is running it" and "this member cannot be reached".
     *
     * @param {{ profile: { connectorUrl: string, ilpAddress: string, connectorSealKey: string }, request: object }} options
     * @returns {Promise<{ status: number | undefined, body: any, text: string }>}
     */
    ask({ profile, request }) {
      // THE OPERATOR'S TIMEOUT BOUNDS THE WHOLE ASK, not one socket inside
      // it. A connector client reads a self-description, may re-price a route
      // and retries a lost packet of its own accord; all of that is between a
      // tenant and its first byte, and `GATEWAY_RESOLVE_TIMEOUT_MS` is what an
      // operator set to say how long that may take. The attempt underneath is
      // left to finish or fail on its own — its rejection is swallowed rather
      // than left to crash a process that has already given up on it.
      let timer;
      const attempt = asked({ profile, request });
      attempt.catch(() => {});
      return Promise.race([
        attempt,
        new Promise((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`did not answer \`status\` within ${timeoutMs} ms`)),
            timeoutMs,
          );
          timer.unref?.();
        }),
      ]).finally(() => clearTimeout(timer));
    },

    close() {
      const open = [...clients.values()];
      clients.clear();
      for (const opening of open) {
        opening.then((client) => client.close?.()).catch(() => {});
      }
    },
  };
}
