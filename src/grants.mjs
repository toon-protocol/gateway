// The grants this gateway holds, and the hostnames they are served at.
//
// Deliberately not called a registry: CONTEXT.md keeps "Registry" for the
// Image Registry and warns it off the Provider Directory, and this is neither.
// It is the set of grants held, which is the words the spec uses.
//
// A grant is addressable on its workload id (spec §3.1.3), so there is at most
// ONE grant per workload here and publishing again replaces it: renewal,
// rotation and a change of Standby Set are all the same act. Which of two
// grants for a workload is current is NIP-01's rule for a replaceable event —
// the later `created_at`, and on a tie the lower id — so every gateway reading
// the same relays holds the same grant whatever order the relays deliver in.
//
// Whether a grant is IN FORCE is not asked here for the CANONICAL hostname:
// `expires_at` is checked when a request arrives (`src/serve.mjs`), so an
// expired grant can be answered with the reason that it expired rather than
// with the reason that no grant exists, and so a grant renewed by its tenant
// starts serving again with no restart and no timer (M5-5).
//
// A readable `name` is the one thing decided here and not there, because it is
// the one thing that is not derived: two tenants may ask for `shop`, and only
// one can have it. It is FIRST COME, FIRST SERVED among the grants this
// gateway holds — a name is claimed when no grant still in force holds it, and
// a later grant claiming a name in use is logged and keeps only its canonical
// hostname. Nothing else about that grant is affected, for the same reason a
// malformed `name` costs only the name: the canonical hostname is the one a
// tenant can always derive, and both workloads keep it. A readable name is
// therefore never ambiguous, and never worth racing for.

import { readGrant } from './grant.mjs';
import { canonicalLabel } from './hostname.mjs';

/** NIP-01 replacement: later `created_at` wins, and a tie goes to the lower id. */
const supersedes = (candidate, held) =>
  candidate.created_at > held.created_at ||
  (candidate.created_at === held.created_at && candidate.id < held.id);

/**
 * @param {{
 *   gatewayPubkey: string,
 *   now?: () => number,
 *   log?: (line: string) => void,
 * }} options
 */
export function createHeldGrants({
  gatewayPubkey,
  now = () => Math.floor(Date.now() / 1000),
  log = () => {},
}) {
  // The NEWEST grant seen per workload, whoever it names — including one that
  // names another gateway. Forgetting those would let an older grant, replayed
  // off a second relay, undo a tenant's rotation and put the workload back.
  /** @type {Map<string, ReturnType<typeof readGrant>>} workload id -> grant */
  const newest = new Map();
  /** @type {Map<string, string>} canonical hostname label -> workload id, ours only */
  const labels = new Map();
  /** @type {Map<string, string>} readable name -> the workload id that claimed it */
  const names = new Map();

  const ours = gatewayPubkey.toLowerCase();
  const isOurs = (grant) => grant !== undefined && grant.gateway === ours;

  const ignore = (event, why) => {
    log(`ignored a grant${event?.id ? ` ${event.id}` : ''}: ${why}`);
    return { accepted: false, why };
  };

  /**
   * The workload a readable name is served for, if any.
   *
   * A claim is checked when it is USED rather than kept on a timer: the holder
   * may since have been rotated to another gateway, or published a grant that
   * no longer asks for the name, and in either the name is free again with
   * nothing to notice it.
   *
   * An EXPIRED grant still holds its name. That is deliberate: a tenant whose
   * readable URL stopped working is told the grant expired, exactly as its
   * canonical hostname says (`src/serve.mjs`), rather than that the hostname
   * means nothing here. What expiry does cost is the claim's priority — a
   * later grant may take the name, which is what `claimName` asks.
   */
  const nameHolder = (name) => {
    const workloadId = names.get(name);
    if (workloadId === undefined) return undefined;
    const grant = newest.get(workloadId);
    if (grant === undefined || !isOurs(grant) || grant.name !== name) {
      names.delete(name);
      return undefined;
    }
    return workloadId;
  };

  /** Give up every name a workload holds, because its grant no longer asks for one. */
  const releaseNamesOf = (workloadId, keep) => {
    for (const [name, holder] of names) {
      if (holder === workloadId && name !== keep) names.delete(name);
    }
  };

  /** First come, first served: claim a grant's `name`, or log why it is not served. */
  const claimName = (grant) => {
    releaseNamesOf(grant.workloadId, grant.name);
    if (grant.name === undefined) return;
    if (labels.has(grant.name) && labels.get(grant.name) !== grant.workloadId) {
      log(
        `grant ${grant.event.id}: the name "${grant.name}" is the canonical hostname of workload ` +
          `${labels.get(grant.name)}; workload ${grant.workloadId} keeps its canonical hostname only`,
      );
      return;
    }
    const holder = nameHolder(grant.name);
    if (holder !== undefined && holder !== grant.workloadId && newest.get(holder).inForceAt(now())) {
      log(
        `grant ${grant.event.id}: the name "${grant.name}" is already held by workload ${holder}, ` +
          `whose grant is still in force; workload ${grant.workloadId} keeps its canonical ` +
          'hostname only',
      );
      return;
    }
    names.set(grant.name, grant.workloadId);
  };

  return {
    /**
     * Offer an event discovered on a relay.
     *
     * Everything that is not a grant for us, or is older than what we hold, is
     * logged and dropped: one bad event on one relay must never stop the other
     * workloads being served.
     */
    offer(event) {
      let grant;
      try {
        grant = readGrant(event);
      } catch (e) {
        return ignore(event, e instanceof Error ? e.message : String(e));
      }

      const current = newest.get(grant.workloadId);
      if (current !== undefined && current.event.id === grant.event.id) {
        // The same grant off a second relay: the ordinary case, not an event
        // worth a log line — several relays carry the same grant on purpose.
        return { accepted: false, why: 'already held' };
      }
      if (current !== undefined && !supersedes(grant.event, current.event)) {
        return ignore(event, `it does not supersede the grant known for ${grant.workloadId}`);
      }

      const label = canonicalLabel(grant.workloadId);
      newest.set(grant.workloadId, grant);

      // A grant naming somebody else is how a tenant ROTATES away from this
      // gateway: the newest grant for a workload decides, and if it is not
      // ours we stop serving that workload rather than keep the old one.
      //
      // The rule is here; what does not exist yet is a subscription that
      // DELIVERS such a grant. It names the new gateway in its `p` tag (spec
      // §3.1.3), so the `#p` filter of §12.1 does not carry it — M5-5 adds the
      // subscription that does, and this is what it will hand the grant to.
      if (!isOurs(grant)) {
        releaseNamesOf(grant.workloadId);
        if (labels.delete(label)) {
          log(`workload ${grant.workloadId} was granted to another gateway; no longer served`);
        }
        return ignore(event, `it names another gateway (${grant.gateway})`);
      }

      labels.set(label, grant.workloadId);
      if (grant.nameProblem !== undefined) log(`grant ${grant.event.id}: ${grant.nameProblem}`);
      claimName(grant);
      log(
        `holding a grant for workload ${grant.workloadId} at ` +
          `${label}, until ${new Date(grant.expiresAt * 1000).toISOString()}`,
      );
      return { accepted: true, grant };
    },

    /** The grant served at one hostname label, or `undefined`. */
    find(label) {
      // The canonical label first, ALWAYS: it is derived from the workload id,
      // so it is the one name that cannot be taken from a workload — not even
      // by another tenant's `name` that happens to spell the same label.
      const workloadId = labels.get(label) ?? nameHolder(label);
      return workloadId === undefined ? undefined : newest.get(workloadId);
    },

    /** Every grant held for this gateway, for a resolver working through them. */
    all() {
      return [...labels.values()].map((workloadId) => newest.get(workloadId));
    },

    /** How many workloads this gateway is serving. */
    get size() {
      return labels.size;
    },
  };
}
