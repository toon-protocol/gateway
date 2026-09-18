// The grants this gateway holds, and the hostnames they are served at.
//
// Deliberately not called a registry: CONTEXT.md keeps "Registry" for the
// Image Registry and warns it off the Provider Directory, and this is neither.
// It is the set of grants held, which is the words the spec uses.
//
// One grant per workload, because one handover per workload is what a gateway
// can act on: a later handover that ADMISSION ACCEPTED replaces the one held,
// and renewal, rotation of the grant's moment and a change of Standby Set are
// all the same act. Nothing is compared here to decide which of two is
// current — there is no `created_at` to compare and no signature to weigh —
// because only the holder of the lease's Continuation Token can derive a grant
// a member will accept (spec §6.5.1). Getting past admission IS the proof that
// this handover's sender may replace what is held (spec §12.1).
//
// Whether a grant is IN FORCE is not asked here for the CANONICAL hostname:
// `expires_at` is checked when a request arrives (`src/serve.mjs`), so an
// expired grant can be answered with the reason that it expired rather than
// with the reason that no grant exists, and so a grant handed over again by
// its tenant starts serving with no restart and no timer (M5-5).
//
// A WITHDRAWAL takes a workload out of all three maps at once (`release`),
// because a tenant that withdrew a workload gave up its readable name with it
// (spec §12.6, §12.7). It takes nothing away from the grant, which goes on
// working at the members until its moment passes.
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

import { canonicalLabel } from './hostname.mjs';

/**
 * @param {{
 *   now?: () => number,
 *   log?: (line: string) => void,
 * }} [options]
 */
export function createHeldGrants({
  now = () => Math.floor(Date.now() / 1000),
  log = () => {},
} = {}) {
  /** @type {Map<string, ReturnType<typeof import('./handover.mjs').readHandover>>} workload id -> its handover */
  const held = new Map();
  /** @type {Map<string, string>} canonical hostname label -> workload id */
  const labels = new Map();
  /** @type {Map<string, string>} readable name -> the workload id that claimed it */
  const names = new Map();

  /**
   * The workload a readable name is served for, if any.
   *
   * A claim is checked when it is USED rather than kept on a timer: the holder
   * may since have handed over a grant that no longer asks for the name, and
   * then the name is free again with nothing to notice it.
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
    const grant = held.get(workloadId);
    if (grant === undefined || grant.name !== name) {
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
        `workload ${grant.workloadId}: the name "${grant.name}" is the canonical hostname of ` +
          `workload ${labels.get(grant.name)}; it keeps its canonical hostname only`,
      );
      return;
    }
    const holder = nameHolder(grant.name);
    if (holder !== undefined && holder !== grant.workloadId && held.get(holder).inForceAt(now())) {
      log(
        `workload ${grant.workloadId}: the name "${grant.name}" is already held by workload ` +
          `${holder}, whose grant is still in force; it keeps its canonical hostname only`,
      );
      return;
    }
    names.set(grant.name, grant.workloadId);
  };

  return {
    /**
     * Serve a workload under a handover admission accepted.
     *
     * Only `src/admit.mjs` calls this, and only after one bounded round of
     * `status` found a member that took the grant (spec §12.1). A handover
     * that got no further than this gateway's own door never reaches here.
     */
    hold(handover) {
      const label = canonicalLabel(handover.workloadId);
      held.set(handover.workloadId, handover);
      labels.set(label, handover.workloadId);
      if (handover.nameProblem !== undefined) {
        log(`workload ${handover.workloadId}: ${handover.nameProblem}`);
      }
      claimName(handover);
      log(
        `holding a grant for workload ${handover.workloadId} at ` +
          `${label}, until ${new Date(handover.expiresAt * 1000).toISOString()}`,
      );
      return handover;
    },

    /** The handover held for one workload, or `undefined`. */
    heldFor(workloadId) {
      return held.get(workloadId);
    },

    /**
     * Stop serving a workload: its canonical hostname and its readable name,
     * at once (spec §12.7).
     *
     * The grant itself is NOT ended by this and could not be: it is a value
     * the tenant derived and the members accept until its moment passes (spec
     * §6.5.1). What ends here is this gateway serving the workload.
     */
    release(workloadId) {
      if (!held.has(workloadId)) return false;
      held.delete(workloadId);
      labels.delete(canonicalLabel(workloadId));
      releaseNamesOf(workloadId);
      return true;
    },

    /** The grant served at one hostname label, or `undefined`. */
    find(label) {
      // The canonical label first, ALWAYS: it is derived from the workload id,
      // so it is the one name that cannot be taken from a workload — not even
      // by another tenant's `name` that happens to spell the same label.
      const workloadId = labels.get(label) ?? nameHolder(label);
      return workloadId === undefined ? undefined : held.get(workloadId);
    },

    /** Every grant this gateway holds, for a resolver working through them. */
    all() {
      return [...labels.values()].map((workloadId) => held.get(workloadId));
    },

    /** How many workloads this gateway is serving. */
    get size() {
      return labels.size;
    },
  };
}
