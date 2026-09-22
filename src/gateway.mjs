// The gateway itself: listeners, the grants it holds, and the relays it reads
// to reach the members those grants name (spec §12, ADR 0013).
//
// It holds no lease, pays for nothing and calls no paid route, it signs
// nothing and it publishes nothing. Its whole authority is a Gateway Grant,
// and a grant reaches it in ONE SEALED PACKET a tenant sends its connector —
// a Gateway Handover (spec §12.1). There is nothing to find on a relay, so
// there is no filter for grants and no account for anybody: the tenant sends
// one packet, this gateway asks the members whether the grant works, and that
// is the whole of being told.
//
// It runs behind its own connector (ADR 0013); in this milestone that
// connector terminates no paid route, and what it forwards is the handover.

import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';

import { createAdmission, createAdmissionRate } from './admit.mjs';
import { createDialer } from './dial.mjs';
import { createTenantDoor } from './door.mjs';
import { createFollower } from './follow.mjs';
import { createHeldGrants } from './grants.mjs';
import { createProfiles } from './profiles.mjs';
import { createRelayPool } from './relays.mjs';
import { createResolver } from './resolve.mjs';
import { withDialRewrites } from './rewrite.mjs';
import { createRequestHandler } from './serve.mjs';
import { createConnectors } from './status.mjs';
import { createWithdrawals } from './withdraw.mjs';

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
 * `probe` is the admission seam (`src/admit.mjs`): the one bounded round of
 * `status` a handover is admitted on. Left out, this gateway runs the real
 * one, which is the same round resolution runs.
 *
 * @param {{
 *   config: ReturnType<typeof import('./config.mjs').readConfig>,
 *   resolve?: import('./serve.mjs').Resolver,
 *   probe?: (handover: any) => Promise<{ told: number, target?: any }>,
 *   pool?: ReturnType<typeof createRelayPool>,
 *   now?: () => number,
 *   log?: (line: string) => void,
 * }} deps
 */
export async function startGateway({
  config,
  resolve,
  probe,
  pool,
  now = () => Math.floor(Date.now() / 1000),
  log = () => {},
}) {
  const relays = pool ?? createRelayPool({ log });
  const grants = createHeldGrants({ now, log });
  const profiles = createProfiles({ pool: relays, relays: config.relays, log });
  const resolver = createResolver({
    profiles,
    // How a member is ASKED (spec §5, §6.1.2): the sealed packet, through the
    // member's own connector, at the free `status` route its Profile names.
    connectors: createConnectors({
      socksProxy: config.socksProxy,
      rewrites: config.dialRewrites,
      timeoutMs: config.resolveTimeoutMs,
      log,
    }),
    // How a WORKLOAD is dialled once a member has said where it is.
    dialer: withDialRewrites(createDialer({ socksProxy: config.socksProxy }), config.dialRewrites),
    now,
    log,
    timeoutMs: config.resolveTimeoutMs,
  });
  // Following the workload: the Takeover watch, the per-cadence re-ask, and
  // the grant that ran out (spec §12.7).
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

  const admission = createAdmission({
    grants,
    probe: probe ?? resolver.probe,
    remember: resolver.remember,
    onSettled: () => follower.refresh(),
    domain: config.domain,
    now,
    log,
    rate: createAdmissionRate({ perMinute: config.admitPerMinute }),
  });

  // Withdrawal: a tenant taking a workload off this gateway before its grant
  // runs out (spec §12.7). It asks nobody, so it is answered on the spot.
  const withdrawals = createWithdrawals({
    grants,
    onWithdrawn: () => follower.refresh(),
    domain: config.domain,
    log,
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

  // The tenant's door: its OWN listener, behind this gateway's connector,
  // where a sealed Gateway Handover (spec §12.1) and a sealed Gateway
  // Withdrawal (§12.7) arrive. It fronts no workload, so no tenant's URL space
  // is carved into (§12.5).
  const door = createHttpServer(createTenantDoor({ admission, withdrawals, log }));
  servers.push(door);
  const handoverPort = await listen(door, config.handoverPort, config.bindAddress);
  log(`listening for Gateway Handovers and Withdrawals on ${config.bindAddress}:${handoverPort}`);

  return {
    config,
    /** The grants this gateway holds. */
    grants,
    /** The relay pool, which every subscription this gateway holds is opened on. */
    pool: relays,
    /** The Standby Set members' Profiles: connectors, Relay Sets, cadences. */
    profiles,
    /** Resolution: `resolveNow`, `probe`, `current`, `forget`. */
    resolver,
    httpPort,
    httpsPort,
    /** Where a sealed Gateway Handover or Withdrawal is forwarded to (spec §12.1, §12.7). */
    handoverPort,

    async stop() {
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
