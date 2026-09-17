// Signed events a test can publish into the stub relay.
//
// Content is serialised in DECLARATION ORDER, not sorted: a grant's `id` is
// the hash of exactly these bytes, and re-serialising with sorted keys makes
// an event the provider's fixtures no longer recognise.

import { readFileSync } from 'node:fs';

import { signEvent } from '../../src/nostr.mjs';
import { K_GATEWAY_GRANT, K_LIVENESS, K_PROFILE, K_TAKEOVER, LABEL } from '../../src/kinds.mjs';

/** The test-only keys, clock and kind numbers every wire fixture was made in. */
export const CONSTANTS = JSON.parse(
  readFileSync(new URL('../fixtures/wire/constants.json', import.meta.url), 'utf8'),
);

export const wireFixture = (name) =>
  JSON.parse(readFileSync(new URL(`../fixtures/wire/${name}.json`, import.meta.url), 'utf8'));

/**
 * A Gateway Grant (spec §3.1.3), signed by a tenant.
 *
 * `d` is the workload id, so publishing again under the same id REPLACES the
 * grant — which is how a test drives renewal, rotation and expiry.
 */
/**
 * @param {{
 *   tenantSecret?: string, workloadId: string, gateway: string,
 *   standbySet?: any, expiresAt?: any, name?: any, createdAt?: number, httpPort?: any,
 * }} options
 */
export function gatewayGrant({
  tenantSecret = CONSTANTS.tenant.secret_key,
  workloadId,
  gateway,
  httpPort = 8080,
  standbySet = [CONSTANTS.provider.public_key],
  expiresAt = CONSTANTS.now + 86_400,
  name,
  createdAt = CONSTANTS.now,
}) {
  const content = { workload_id: workloadId, gateway, http_port: httpPort, standby_set: standbySet, expires_at: expiresAt };
  if (name !== undefined) content.name = name;
  return signEvent(tenantSecret, {
    kind: K_GATEWAY_GRANT,
    created_at: createdAt,
    tags: [['d', workloadId], ['p', gateway], ['L', LABEL]],
    content: JSON.stringify(content),
  });
}

/** A Provider Profile (spec §4.1), signed by a provider. */
/**
 * @param {{
 *   providerSecret?: string, ilpAddress?: string, connectorUrl?: string, relays?: string[],
 *   host?: string, hidden?: boolean, livenessCadenceS?: number, createdAt?: number,
 * }} [options]
 */
export function providerProfile({
  providerSecret = CONSTANTS.provider.secret_key,
  ilpAddress = 'g.fixture',
  connectorUrl,
  relays = [],
  host = '203.0.113.7',
  hidden = false,
  livenessCadenceS = 60,
  createdAt = CONSTANTS.now,
} = {}) {
  const content = {
    ilp_address: ilpAddress,
    connector_url: connectorUrl,
    connector_seal_key: '0x04' + '11'.repeat(64),
    relays,
    settlement: [{ chain: 'solana', token: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 }],
    isolation: 'shared-kernel',
    hidden,
    liveness_cadence_s: livenessCadenceS,
  };
  if (!hidden && host !== undefined) content.host = host;
  return signEvent(providerSecret, {
    kind: K_PROFILE,
    created_at: createdAt,
    tags: [['L', LABEL]],
    content: JSON.stringify(content),
  });
}

/** A Takeover claim (spec §7.1), signed by the standby that claims the workload. */
/**
 * @param {{ standbySecret?: string, workloadId: string, primary?: string, createdAt?: number }} options
 */
export function takeover({
  standbySecret = CONSTANTS.standby_provider.secret_key,
  workloadId,
  primary = CONSTANTS.primary_provider.public_key,
  createdAt = CONSTANTS.now,
}) {
  return signEvent(standbySecret, {
    kind: K_TAKEOVER,
    created_at: createdAt,
    tags: [['d', workloadId], ['L', LABEL]],
    content: JSON.stringify({ workload_id: workloadId, primary }),
  });
}

/** A Liveness statement (spec §4.3), signed by a provider. */
/**
 * @param {{ providerSecret?: string, createdAt?: number, expiration?: number, available?: number }} [options]
 */
export function liveness({
  providerSecret = CONSTANTS.provider.secret_key,
  createdAt = CONSTANTS.now,
  expiration = CONSTANTS.now + 120,
  available = 1,
} = {}) {
  return signEvent(providerSecret, {
    kind: K_LIVENESS,
    created_at: createdAt,
    tags: [['expiration', String(expiration)], ['L', LABEL]],
    content: JSON.stringify({ available }),
  });
}
