// The Provider Profiles of a workload's Standby Set (spec §4.1).
//
// Resolution follows the GRANT: the grant names the members, and each member's
// Profile is the only thing that says where to ask it anything — its
// `connector_url` — and where it publishes — its Relay Set. Nothing else here
// is a source of truth about a member: a gateway never guesses a connector
// from a host, and never asks a member the grant does not name.
//
// Two relay sets are in play and they are not the same. A gateway is
// configured with relays of its own (`GATEWAY_RELAYS`), which is where it
// looks first; a provider publishes its Profile to ITS OWN Relay Set (§4),
// which the gateway may not be configured with. So once a Profile is found, the
// relays it names are added and the subscription is reopened across all of
// them: a provider that republishes to its own relays — a new connector, a
// changed Relay Set — is then seen without the gateway being reconfigured.
//
// A relay is not trusted here any more than it is for a grant: every event has
// its id re-derived and its signature checked, and a Profile that does not
// parse is logged and dropped rather than taken as a member with no connector.

import { K_PROFILE } from './kinds.mjs';
import { verifyEvent } from './nostr.mjs';

/**
 * Read one event as a Provider Profile, or throw saying which field is wrong.
 *
 * Only what a gateway uses is required. `relays` and `liveness_cadence_s` are
 * read because following the workload needs them (M5-5): the Takeover a
 * gateway watches for is published to the primary's Relay Set, and the settle
 * window is counted in the primary's Liveness cadence (spec §7.1).
 */
export function readProfile(event) {
  if (!verifyEvent(event)) throw new Error('its id or signature does not verify');
  if (event.kind !== K_PROFILE) {
    throw new Error(`it is kind ${event.kind}, not a Provider Profile (kind ${K_PROFILE})`);
  }

  let content;
  try {
    content = JSON.parse(event.content);
  } catch {
    throw new Error('its content is not JSON');
  }
  if (content === null || typeof content !== 'object' || Array.isArray(content)) {
    throw new Error('its content is not a JSON object');
  }

  const { connector_url: connectorUrl, relays, liveness_cadence_s: cadence } = content;
  if (typeof connectorUrl !== 'string' || connectorUrl === '') {
    throw new Error('its `connector_url` is missing: there is nowhere to ask this member anything');
  }
  try {
    new URL(connectorUrl);
  } catch {
    throw new Error(`its \`connector_url\` is not a URL: ${JSON.stringify(connectorUrl)}`);
  }

  return {
    provider: event.pubkey,
    connectorUrl,
    /** The provider's own Relay Set (spec §4), which may not be ours. */
    relays: Array.isArray(relays) ? relays.filter((r) => typeof r === 'string') : [],
    /** How often this provider republishes Liveness; the unit M5-5 counts in. */
    livenessCadenceS: Number.isInteger(cadence) && cadence > 0 ? cadence : undefined,
    event,
  };
}

/** NIP-01 replacement for a replaceable event: later wins, a tie goes to the lower id. */
const supersedes = (candidate, held) =>
  candidate.created_at > held.created_at ||
  (candidate.created_at === held.created_at && candidate.id < held.id);

/**
 * The Profiles of every provider this gateway has reason to ask about.
 *
 * @param {{
 *   pool: { subscribe: Function },
 *   relays: string[],
 *   log?: (line: string) => void,
 * }} deps
 */
export function createProfiles({ pool, relays, log = () => {} }) {
  /** @type {Map<string, ReturnType<typeof readProfile>>} provider -> Profile */
  const known = new Map();
  /** @type {Map<string, (() => void)[]>} provider -> whoever is waiting for its Profile */
  const waiting = new Map();
  /** Every provider asked about, so one filter covers them all. */
  const watched = new Set();
  /** Our own relays, plus every Relay Set a Profile has named. */
  const relayUrls = new Set(relays);
  /** @type {{ close: () => void } | null} */
  let subscription = null;

  const arrived = (provider) => {
    for (const wake of waiting.get(provider) ?? []) wake();
    waiting.delete(provider);
  };

  const offer = (event) => {
    if (event?.kind !== K_PROFILE) return;
    const held = known.get(event.pubkey);
    if (held !== undefined && !supersedes(event, held.event)) return;
    let profile;
    try {
      profile = readProfile(event);
    } catch (e) {
      log(`ignored a Provider Profile${event.id ? ` ${event.id}` : ''}: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    known.set(profile.provider, profile);
    arrived(profile.provider);

    const unseen = profile.relays.filter((url) => /^wss?:\/\//.test(url) && !relayUrls.has(url));
    if (unseen.length > 0) {
      for (const url of unseen) relayUrls.add(url);
      log(`provider ${profile.provider} publishes to ${unseen.join(', ')}; watching those too`);
      reopen();
    }
  };

  const reopen = () => {
    subscription?.close();
    subscription = null;
    if (watched.size === 0) return;
    subscription = pool.subscribe({
      relays: [...relayUrls],
      filters: [{ kinds: [K_PROFILE], authors: [...watched] }],
      onEvent: offer,
    });
  };

  return {
    /**
     * Watch these providers' Profiles, and keep watching.
     *
     * Idempotent: a member already watched changes nothing, so a resolution
     * per request costs no subscriptions.
     */
    watch(providers) {
      const added = providers.filter((provider) => !watched.has(provider));
      if (added.length === 0) return;
      for (const provider of added) watched.add(provider);
      reopen();
    },

    /** The Profile held for a provider, or `undefined`. */
    get: (provider) => known.get(provider),

    /**
     * Wait until every one of these providers has a Profile, or until the
     * deadline. A member still missing one afterwards is a member this gateway
     * cannot reach, which is resolution's answer rather than an error here.
     */
    async waitFor(providers, { timeoutMs }) {
      const missing = providers.filter((provider) => !known.has(provider));
      if (missing.length === 0) return;
      let timer;
      await Promise.race([
        Promise.all(
          missing.map(
            (provider) =>
              new Promise((wake) => {
                waiting.set(provider, [...(waiting.get(provider) ?? []), () => wake(undefined)]);
              }),
          ),
        ),
        new Promise((done) => {
          timer = setTimeout(() => done(undefined), timeoutMs);
          timer.unref?.();
        }),
      ]);
      clearTimeout(timer);
    },

    close() {
      subscription?.close();
      subscription = null;
      watched.clear();
      waiting.clear();
    },
  };
}
