// Following the workload rather than the provider it was first found on
// (spec §12.7).
//
// Resolution (`src/resolve.mjs`) answers "where is this workload?" once. This
// is what keeps the answer true: WHEN the Standby Set is asked again, and when
// a workload stops being served at all. Nothing here forwards anything, and
// nothing here decides where a request goes — it hands the resolver reasons to
// re-ask and, once, a reason to forget.
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
// reason and to the same end: the last known target keeps serving. Because a
// race settles on the EARLIEST claim, a second claimant may only bring that
// deadline forward — so the wait is bounded by the first claim's window and
// nobody can extend it by announcing again.
//
// WHAT IT DOES NOT DO. It never drops a target itself on the strength of a
// Takeover or a cadence — only a FINISHED resolution changes or withdraws one
// (`src/resolve.mjs`), so nothing here takes a healthy workload offline while
// a slow relay or a slow member is still being waited for. The one thing it
// does forget is a grant that ran out, because this gateway has then lost the
// authority to ask about that lease at all.
//
// A TAKEOVER IS THE ONLY EVENT IT WATCHES FOR. A gateway no longer reads a
// relay on a workload's account for anything else (spec §12.1): there is no
// grant to find, and a tenant that wants this gateway to stop serving a
// workload sends it a Gateway Withdrawal rather than publishing anything.

import { K_TAKEOVER } from './kinds.mjs';
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
  /**
   * One record per workload followed, and everything about following it:
   * the grant it is followed under, the Takeover watch open for it, the claim
   * that opened its settle window and when that window ends.
   *
   * One map rather than four, because every one of these begins and ends
   * together: a grant that ran out stops being followed in every one of these
   * senses at the same moment.
   *
   * @typedef {{
   *   grant: any,
   *   relays: string[],
   *   subscription: { close: () => void },
   *   claims: Map<string, { id: string, createdAt: number }>,
   *   settleDueAt?: number,
   *   settledThrough: number,
   * }} Followed
   */
  /** @type {Map<string, Followed>} workload id -> what is known about following it */
  const following = new Map();
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
   * Relay Set leaves nowhere else to look but the relays this gateway is
   * configured with.
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
   * here, and a claim signed by a key the HANDOVER does not name is not a
   * claim on this workload (§7.1 counts claims from `standby_set` and nobody
   * else). Without that check, anyone could publish a kind 30433 with this `d`
   * and hold up every re-ask for two cadences.
   */
  const onTakeover = (workloadId) => (event) => {
    const followed = following.get(workloadId);
    if (followed === undefined) return;
    if (event?.kind !== K_TAKEOVER || tagValue(event, 'd') !== workloadId) return;

    // A claim is addressable on `(kind, pubkey, d)`, so each claimant has at
    // most one: the same claim off a second relay, and one a relay replays
    // after that claimant published a later claim, are both ordinary.
    const last = followed.claims.get(event.pubkey);
    if (last !== undefined && (last.id === event.id || event.created_at <= last.createdAt)) return;
    // A claim from a race already settled here must not open a window again:
    // relays replay, and this gateway may have restarted.
    if (event.created_at <= followed.settledThrough) return;

    if (!verifyEvent(event)) {
      log(`ignored a Takeover for workload ${workloadId}: its id or signature does not verify`);
      return;
    }
    if (!followed.grant.standbySet.includes(event.pubkey)) {
      log(
        `ignored a Takeover claim for workload ${workloadId}: it is signed by ${event.pubkey}, ` +
          'which the handover\'s `standby_set` does not name',
      );
      return;
    }

    const cadence = cadenceOf(followed.grant);
    const dueAt = event.created_at + 2 * cadence;
    followed.claims.set(event.pubkey, { id: event.id, createdAt: event.created_at });
    // THE EARLIEST CLAIM DECIDES. §7.1 settles a race on the earliest
    // `created_at`, so the member that will be running the workload is the one
    // whose window ends first: a second claimant, and a second round, can only
    // bring this gateway's deadline forward, never push it out. Otherwise a
    // standby announcing late would hold a stale target past the winner's
    // start — and hold up the per-cadence re-ask with it.
    if (followed.settleDueAt !== undefined && followed.settleDueAt <= dueAt) return;
    followed.settleDueAt = dueAt;
    log(
      `workload ${workloadId}: ${event.pubkey} claims it. Its settle window of 2 x ${cadence} s ` +
        `ends at ${new Date(dueAt * 1000).toISOString()}; the Standby Set is asked again then, ` +
        'and not before (spec §7.1)',
    );
  };

  /** Follow what is held now: the grants and their Takeover watches. */
  const sync = () => {
    if (closed) return;
    const at = now();
    /** @type {Map<string, any>} */
    const held = new Map(
      grants
        .all()
        .filter((grant) => grant !== undefined && grant.inForceAt(at))
        .map((grant) => [grant.workloadId, grant]),
    );

    // A grant that ran out: this gateway may no longer read that lease, so it
    // stops watching, stops asking, and forgets where the workload was. An
    // expired grant is not carried to a provider, which would refuse it
    // `bad_grant` (spec §6.5.1) and rightly.
    for (const [workloadId, followed] of following) {
      if (held.has(workloadId)) continue;
      followed.subscription.close();
      following.delete(workloadId);
      if (resolver.forget(workloadId)) {
        log(
          `workload ${workloadId} is no longer served: its grant expired. Forgetting where it ` +
            'was running',
        );
      }
    }

    for (const grant of held.values()) {
      // The primary's Profile is where both the Relay Set and the cadence come
      // from, so it is watched whether or not a request has ever arrived.
      profiles.watch(grant.standbySet);

      const want = relaySetOf(grant);
      const followed = following.get(grant.workloadId);
      if (followed !== undefined) {
        followed.grant = grant;
        if (sameList(followed.relays, want)) continue;
        followed.subscription.close();
      }
      following.set(grant.workloadId, {
        claims: new Map(),
        settledThrough: 0,
        ...followed,
        grant,
        relays: want,
        subscription: pool.subscribe({
          relays: want,
          filters: [{ kinds: [K_TAKEOVER], '#d': [grant.workloadId] }],
          onEvent: onTakeover(grant.workloadId),
        }),
      });
      log(`workload ${grant.workloadId}: watching ${want.join(', ')} for a Takeover`);
    }

    // And no Profile is watched but for a member of something followed. An
    // admission round watches the members it is about before it asks them
    // (`src/resolve.mjs`), and a handover anyone can seal names whoever it
    // likes: without this, one refused handover would leave its fabricated
    // pubkeys in the live filter for good, which is not the "dropped, and not
    // remembered" spec §12.1 requires of one.
    profiles.keepOnly([...held.values()].flatMap((grant) => grant.standbySet));
  };

  /** Re-sync after the events of one turn, rather than once per event. */
  const scheduleSync = () => {
    if (queued || closed) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      sync();
    });
  };

  const tick = () => {
    sync();
    const at = now();
    for (const [workloadId, followed] of following) {
      if (followed.settleDueAt !== undefined) {
        // Inside a settle window nothing else re-asks either: the standby has
        // not started the workload yet, so a round of `status` now could only
        // find nothing running and drop a target that is about to be replaced.
        if (at < followed.settleDueAt) continue;
        followed.settleDueAt = undefined;
        // Nothing this window was opened on reopens it, however often a relay
        // replays it: the race it belonged to has been settled here.
        for (const claim of followed.claims.values()) {
          followed.settledThrough = Math.max(followed.settledThrough, claim.createdAt);
        }
        log(`workload ${workloadId}: its settle window has passed; asking the Standby Set again`);
        reask(followed.grant, 'a Takeover settled');
        continue;
      }
      const target = resolver.current(workloadId);
      if (target !== undefined && at - target.at >= cadenceOf(followed.grant)) {
        reask(followed.grant, 'a Liveness cadence has passed');
      }
    }
  };

  return {
    /**
     * Follow what is held now.
     *
     * Admission calls it after EVERY round it finishes, not only an accepted
     * one: an accepted handover starts being followed at once rather than on
     * the next tick, and a refused one has its members let go of at once
     * rather than lingering in the Profile filter.
     */
    refresh: scheduleSync,

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
      for (const followed of following.values()) followed.subscription.close();
      following.clear();
    },
  };
}
