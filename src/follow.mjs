// Following the workload rather than the provider it was first found on
// (spec §12.7).
//
// Resolution (`src/resolve.mjs`) answers "where is this workload?" once. This
// is what keeps the answer true: WHEN the Standby Set is asked again, and when
// a workload stops being served at all. Nothing here forwards anything, and
// nothing here decides where a request goes — it hands the resolver reasons to
// re-ask and, twice, a reason to forget.
//
// THREE REASONS TO RE-ASK, and they are not interchangeable:
//
//   1. A Takeover (kind 30433) for a workload this gateway holds a grant for,
//      on the PRIMARY's Relay Set — where §7.1 says a standby publishes its
//      claim. The workload moved, or is about to.
//   2. A Liveness cadence passing with a target held. A self-stop (§7.1), an
//      expiry and an eviction (§6.7) announce nothing to a gateway, so the
//      only thing that finds them is asking again.
//   3. Nothing at all: a request for a workload with no target resolves on the
//      spot (`src/resolve.mjs`), which is not this module's business.
//
// THE SETTLE WINDOW IS THE POINT OF (1). A Takeover event does not mean the
// workload has moved; it means a standby announced that it intends to take it,
// and §7.1 gives it two of the primary's Liveness cadences — counted from its
// OWN announcement, which is the event's `created_at` — before it starts
// anything. Asking inside that window costs a round of `status` to every
// member and can only learn that nothing is running: the primary has stopped
// and the standby has not started. So the window is waited out, from the
// event's `created_at` rather than from when this gateway happened to see it,
// and the per-cadence re-ask of (2) is held off while it runs, for the same
// reason and to the same end: the last known target keeps serving.
//
// WHAT IT DOES NOT DO. It never drops a target itself on the strength of a
// Takeover or a cadence — only a FINISHED resolution changes or withdraws one
// (`src/resolve.mjs`), so a slow relay, a slow connector or a member that will
// not answer never takes a healthy workload offline. The two things it does
// forget are a grant that ran out and a workload rotated to another gateway,
// because in both cases this gateway has lost the authority to ask at all.

import { K_GATEWAY_GRANT, K_TAKEOVER } from './kinds.mjs';
import { tagValue, verifyEvent } from './nostr.mjs';

/**
 * How often the follower looks at the clock.
 *
 * It decides nothing: what is due, and when, is counted in the grant's and the
 * Profile's own seconds. This is only how late the gateway may be in noticing,
 * and it is a second because a Liveness cadence is tens of seconds at least.
 */
export const FOLLOW_TICK_MS = 1000;

/**
 * The cadence assumed when the primary's Profile states none.
 *
 * `liveness_cadence_s` is a required Profile field (spec §4.1), so a Profile
 * without one is defective; refusing to follow the workload at all would
 * punish the tenant for its provider's Profile, and guessing too short would
 * ask a provider for `status` far more often than it publishes anything.
 */
export const DEFAULT_LIVENESS_CADENCE_S = 60;

const sameList = (a, b) => a.length === b.length && a.every((value, i) => value === b[i]);

/**
 * @param {{
 *   grants: ReturnType<typeof import('./grants.mjs').createHeldGrants>,
 *   profiles: ReturnType<typeof import('./profiles.mjs').createProfiles>,
 *   resolver: ReturnType<typeof import('./resolve.mjs').createResolver>,
 *   pool: { subscribe: Function },
 *   relays: string[],
 *   now?: () => number,
 *   log?: (line: string) => void,
 *   tickMs?: number,
 * }} deps
 */
export function createFollower({
  grants,
  profiles,
  resolver,
  pool,
  relays,
  now = () => Math.floor(Date.now() / 1000),
  log = () => {},
  tickMs = FOLLOW_TICK_MS,
}) {
  /** The grants being followed, by workload id: what every decision here is about. */
  /** @type {Map<string, any>} */
  let held = new Map();
  /** One Takeover subscription per workload, on that workload's primary's relays. */
  /** @type {Map<string, { relays: string[], subscription: { close: () => void } }>} */
  const takeovers = new Map();
  /** Workload id -> when its settle window ends, while one is running. */
  /** @type {Map<string, number>} */
  const settling = new Map();
  /** Takeover events already counted: several relays carry the same claim. */
  /** @type {Set<string>} */
  const claimed = new Set();
  /** The one subscription that can deliver a grant rotating a workload away. */
  /** @type {{ ids: string[], subscription: { close: () => void } } | null} */
  let rotation = null;
  /** @type {NodeJS.Timeout | null} */
  let timer = null;
  let queued = false;
  let closed = false;

  /** The primary is `standby_set[0]` (spec §7): its Profile is what is counted in. */
  const primaryOf = (grant) => profiles.get(grant.standbySet[0]);

  const cadenceOf = (grant) => primaryOf(grant)?.livenessCadenceS ?? DEFAULT_LIVENESS_CADENCE_S;

  /**
   * Where a workload's Takeover is watched for: the PRIMARY's Relay Set.
   *
   * That is where §7.1 has a standby publish its claim, and it need not be a
   * relay this gateway is configured with. A primary whose Profile names no
   * Relay Set leaves nowhere else to look but the relays this gateway already
   * watches, which is where its tenant's grant came from.
   */
  const relaySetOf = (grant) => {
    const theirs = primaryOf(grant)?.relays ?? [];
    return [...(theirs.length > 0 ? theirs : relays)].sort();
  };

  const reask = (grant, why) => {
    Promise.resolve(resolver.resolveNow(grant)).catch((e) =>
      log(
        `workload ${grant.workloadId}: asking the Standby Set again (${why}) threw: ` +
          `${e instanceof Error ? e.message : String(e)}`,
      ),
    );
  };

  /**
   * A Takeover event off the primary's Relay Set.
   *
   * A relay is trusted for nothing: the event's id and signature are checked
   * here, and a claim signed by a key the GRANT does not name is not a claim
   * on this workload (§7.1 counts claims from `standby_set` and nobody else).
   * Without that check, anyone could publish a kind 30433 with this `d` and
   * hold up every re-ask for two cadences.
   */
  const heard = (workloadId) => (event) => {
    const grant = held.get(workloadId);
    if (grant === undefined) return;
    if (event?.kind !== K_TAKEOVER || tagValue(event, 'd') !== workloadId) return;
    if (claimed.has(event.id)) return;
    if (!verifyEvent(event)) {
      log(`ignored a Takeover for workload ${workloadId}: its id or signature does not verify`);
      return;
    }
    if (!grant.standbySet.includes(event.pubkey)) {
      log(
        `ignored a Takeover claim for workload ${workloadId}: it is signed by ${event.pubkey}, ` +
          'which the grant\'s `standby_set` does not name',
      );
      return;
    }
    claimed.add(event.id);
    const cadence = cadenceOf(grant);
    const dueAt = event.created_at + 2 * cadence;
    settling.set(workloadId, dueAt);
    log(
      `workload ${workloadId}: ${event.pubkey} claims it. Its settle window of 2 x ${cadence} s ` +
        `ends at ${new Date(dueAt * 1000).toISOString()}; the Standby Set is asked again then, ` +
        'and not before (spec §7.1)',
    );
  };

  /**
   * The one subscription that can deliver a grant rotating a workload AWAY.
   *
   * Such a grant names the other gateway in its `p` tag, so §12.1's `#p`
   * filter never carries it: it is found on the workload ids this gateway
   * holds, on the relays it is configured with — which is where this tenant
   * published the grant that brought the workload here.
   */
  const syncRotation = (ids) => {
    if (rotation !== null && sameList(rotation.ids, ids)) return;
    rotation?.subscription.close();
    rotation = null;
    if (ids.length === 0) return;
    rotation = {
      ids,
      subscription: pool.subscribe({
        relays,
        filters: [{ kinds: [K_GATEWAY_GRANT], '#d': ids }],
        onEvent: (event) => offer(event),
      }),
    };
  };

  /** Follow what is held now: the grants, their Takeover watches, the rotations. */
  const sync = () => {
    if (closed) return;
    held = new Map(
      grants
        .all()
        .filter((grant) => grant !== undefined)
        .map((grant) => [grant.workloadId, grant]),
    );
    const at = now();

    // A workload rotated away, or a grant that ran out: this gateway may no
    // longer read that lease, so it stops watching, stops asking, and forgets
    // where the workload was. An expired grant is not carried to a provider,
    // which would refuse it `bad_grant` (spec §6.5) and rightly.
    for (const [workloadId, watch] of takeovers) {
      const grant = held.get(workloadId);
      if (grant !== undefined && grant.inForceAt(at)) continue;
      watch.subscription.close();
      takeovers.delete(workloadId);
      settling.delete(workloadId);
      if (resolver.forget(workloadId)) {
        log(
          `workload ${workloadId} is no longer served: ${
            grant === undefined ? 'its grant names another gateway' : 'its grant expired'
          }. Forgetting where it was running`,
        );
      }
    }

    /** @type {string[]} */
    const following = [];
    for (const grant of held.values()) {
      if (!grant.inForceAt(at)) continue;
      following.push(grant.workloadId);
      // The primary's Profile is where both the Relay Set and the cadence come
      // from, so it is watched whether or not a request has ever arrived.
      profiles.watch(grant.standbySet);

      const want = relaySetOf(grant);
      const watch = takeovers.get(grant.workloadId);
      if (watch !== undefined && sameList(watch.relays, want)) continue;
      watch?.subscription.close();
      takeovers.set(grant.workloadId, {
        relays: want,
        subscription: pool.subscribe({
          relays: want,
          filters: [{ kinds: [K_TAKEOVER], '#d': [grant.workloadId] }],
          onEvent: heard(grant.workloadId),
        }),
      });
      log(`workload ${grant.workloadId}: watching ${want.join(', ')} for a Takeover`);
    }

    syncRotation(following.sort());
  };

  /** Re-sync after the events of one turn, rather than once per event. */
  const soon = () => {
    if (queued || closed) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      sync();
    });
  };

  /**
   * Offer an event to the grants held, and follow whatever it changed.
   *
   * Every grant this gateway sees arrives through here — the `#p` filter of
   * §12.1 and the rotation watch above — so that a grant taking a workload
   * away takes its Takeover watch and its target with it.
   */
  const offer = (event) => {
    const outcome = grants.offer(event);
    soon();
    return outcome;
  };

  const tick = () => {
    sync();
    const at = now();
    for (const grant of held.values()) {
      if (!grant.inForceAt(at)) continue;
      const due = settling.get(grant.workloadId);
      if (due !== undefined) {
        // Inside a settle window nothing else re-asks either: the standby has
        // not started the workload yet, so a round of `status` now could only
        // find nothing running and drop a target that is about to be replaced.
        if (at < due) continue;
        settling.delete(grant.workloadId);
        log(`workload ${grant.workloadId}: its settle window has passed; asking the Standby Set again`);
        reask(grant, 'a Takeover settled');
        continue;
      }
      const target = resolver.current(grant.workloadId);
      if (target !== undefined && at - target.at >= cadenceOf(grant)) {
        reask(grant, 'a Liveness cadence has passed');
      }
    }
  };

  return {
    /** Offer a grant event, and follow what it changed. */
    offer,

    /** Start following: watch what is held, and keep looking at the clock. */
    start() {
      if (timer !== null || closed) return;
      sync();
      timer = setInterval(tick, tickMs);
      timer.unref?.();
    },

    close() {
      closed = true;
      if (timer !== null) clearInterval(timer);
      timer = null;
      for (const watch of takeovers.values()) watch.subscription.close();
      takeovers.clear();
      rotation?.subscription.close();
      rotation = null;
      settling.clear();
      claimed.clear();
      held = new Map();
    },
  };
}
