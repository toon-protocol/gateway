// Signed events a test can publish into the stub relay.
//
// Everything here is something a gateway READS off a relay: a member's
// Provider Profile, its Liveness, and a standby's Takeover. There is no grant
// among them any more — a grant arrives in a sealed packet (spec §12.1), which
// is `tests/helpers/handover.mjs`.
//
// Content is serialised in DECLARATION ORDER, not sorted: an event's `id` is
// the hash of exactly these bytes, and re-serialising with sorted keys makes
// an event the provider's fixtures no longer recognise.

import { readFileSync } from 'node:fs';

import { K_LIVENESS, K_PROFILE, K_TAKEOVER, LABEL } from '../../src/kinds.mjs';
import { signEvent } from './sign.mjs';

/** The test-only keys, clock and kind numbers every wire fixture was made in. */
export const CONSTANTS = JSON.parse(
  readFileSync(new URL('../fixtures/wire/constants.json', import.meta.url), 'utf8'),
);

export const wireFixture = (name) =>
  JSON.parse(readFileSync(new URL(`../fixtures/wire/${name}.json`, import.meta.url), 'utf8'));

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
