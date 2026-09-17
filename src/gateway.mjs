// The gateway itself: listeners, the grants it holds, and the relays it
// watches for more (spec §12, ADR 0013).
//
// It holds no lease, pays for nothing and calls no paid route. Its whole
// authority is the Gateway Grants tenants publish naming it, and it finds
// those with ONE relay filter — kind 30438 with `#p` equal to its own public
// key — so a tenant that wants a hostname publishes a grant and does nothing
// else. Nobody has to make contact with this process.
//
// It runs behind its own connector (ADR 0013); in this milestone that
// connector terminates no paid route.

import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';

import { createDialer } from './dial.mjs';
import { createFollower } from './follow.mjs';
import { K_GATEWAY_GRANT } from './kinds.mjs';
import { createHeldGrants } from './grants.mjs';
import { createProfiles } from './profiles.mjs';
import { createRelayPool, grantFilter } from './relays.mjs';
import { createResolver } from './resolve.mjs';
import { createRequestHandler } from './serve.mjs';

const listen = (server, port, address) =>
  new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, address, () => {
      server.removeListener('error', reject);
      resolve(/** @type {{ port: number }} */ (server.address()).port);
    });
  });

/**
 * Start a Workload Gateway.
 *
 * `resolve` is the resolver seam (`src/serve.mjs`). Left out, this gateway
 * runs the real one: Profiles off the relays, `status` to every Standby Set
 * member, and forwarding to whichever is running the workload.
 *
 * @param {{
 *   config: ReturnType<typeof import('./config.mjs').readConfig>,
 *   resolve?: import('./serve.mjs').Resolver,
 *   pool?: ReturnType<typeof createRelayPool>,
 *   now?: () => number,
 *   log?: (line: string) => void,
 * }} deps
 */
export async function startGateway({
  config,
  resolve,
  pool,
  now = () => Math.floor(Date.now() / 1000),
  log = () => {},
}) {
  const relays = pool ?? createRelayPool({ log });
  const grants = createHeldGrants({ gatewayPubkey: config.publicKey, now, log });
  const profiles = createProfiles({ pool: relays, relays: config.relays, log });
  const resolver = createResolver({
    secretKey: config.secretKey,
    profiles,
    dialer: createDialer({ socksProxy: config.socksProxy }),
    now,
    log,
    timeoutMs: config.resolveTimeoutMs,
  });
  // Following the workload: the Takeover watch, the per-cadence re-ask, and
  // the two things that withdraw a workload (spec §12.7). Every grant event
  // goes through it, so a rotation takes its Takeover watch with it.
  const follower = createFollower({
    grants,
    profiles,
    resolver,
    pool: relays,
    relays: config.relays,
    now,
    log,
    tickMs: config.followTickMs,
  });
  const handler = createRequestHandler({
    domain: config.domain,
    grants,
    resolve: resolve ?? resolver.resolve,
    now,
    log,
  });

  /** Resolves the first time a relay has sent everything it already held. */
  let markCaughtUp = () => {};
  const caughtUp = new Promise((done) => {
    markCaughtUp = () => done(undefined);
  });

  const subscription = relays.subscribe({
    relays: config.relays,
    filters: [grantFilter(config.publicKey, K_GATEWAY_GRANT)],
    onEvent: (event) => follower.offer(event),
    onEose: (relay) => {
      log(`relay ${relay}: caught up on grants`);
      markCaughtUp();
    },
  });

  follower.start();

  /** @type {import('node:http').Server[]} */
  const servers = [];
  // A socket an upgrade hijacked is no longer one the server counts, so
  // `close()` would not wait for it and `closeAllConnections()` would not end
  // it: a gateway fronting one WebSocket a tenant holds open for hours would
  // simply never finish shutting down. They are tracked here instead.
  /** @type {Set<import('node:stream').Duplex>} */
  const upgraded = new Set();
  const wire = (server, secure) => {
    server.on('request', (req, res) => handler.handleRequest(req, res, { secure }));
    server.on('upgrade', (req, socket, head) => {
      upgraded.add(socket);
      socket.on('close', () => upgraded.delete(socket));
      handler.handleUpgrade(req, socket, head, { secure });
    });
    servers.push(server);
    return server;
  };

  // TLS is terminated here, for THIS gateway's domain, with this gateway's own
  // certificate — which is the point of ADR 0013: a workload is reachable over
  // HTTPS while holding no certificate, and no provider ever sees a key.
  let httpsPort = null;
  if (config.tls !== null) {
    const server = wire(createHttpsServer({ cert: config.tls.cert, key: config.tls.key }), true);
    httpsPort = await listen(server, config.httpsPort, config.bindAddress);
    log(`listening for HTTPS on ${config.bindAddress}:${httpsPort} for *.${config.domain}`);
  }

  // The plain listener is for development, and for a deployment that
  // terminates TLS in front of this process.
  let httpPort = null;
  if (config.httpPort !== null) {
    const server = wire(createHttpServer(), false);
    httpPort = await listen(server, config.httpPort, config.bindAddress);
    log(`listening for HTTP on ${config.bindAddress}:${httpPort} for *.${config.domain}`);
  }

  return {
    config,
    /** The grants this gateway holds. */
    grants,
    /** The relay pool, so M5-5 can open its own Takeover subscriptions on it. */
    pool: relays,
    /** The Standby Set members' Profiles: connectors, Relay Sets, cadences. */
    profiles,
    /** Resolution: `resolveNow`, `current`, `forget`. */
    resolver,
    /** Following the workload: the Takeover watch and the per-cadence re-ask. */
    follower,
    httpPort,
    httpsPort,
    /** Resolves once some relay has replayed the grants it already held. */
    caughtUp: () => caughtUp,

    async stop() {
      subscription.close();
      follower.close();
      profiles.close();
      resolver.close();
      relays.close();
      for (const socket of upgraded) socket.destroy();
      upgraded.clear();
      await Promise.all(
        servers.map(
          (server) =>
            new Promise((done) => {
              server.closeAllConnections?.();
              server.close(() => done(undefined));
            }),
        ),
      );
    },
  };
}
