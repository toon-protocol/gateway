// The grants this gateway holds, and the hostnames they are served at.
//
// A grant is addressable on its workload id (spec §3.1.3), so there is at most
// ONE grant per workload here and publishing again replaces it: renewal,
// rotation and a change of Standby Set are all the same act. Which of two
// grants for a workload is current is NIP-01's rule for a replaceable event —
// the later `created_at`, and on a tie the lower id — so every gateway reading
// the same relays holds the same grant whatever order the relays deliver in.
//
// Whether a grant is IN FORCE is not asked here: `expires_at` is checked when
// a request arrives (`src/serve.mjs`), so an expired grant can be answered
// with the reason that it expired rather than with the reason that no grant
// exists, and so a grant renewed by its tenant starts serving again with no
// restart and no timer (M5-5).

import { readGrant } from './grant.mjs';
import { canonicalLabel } from './hostname.mjs';

/** NIP-01 replacement: later `created_at` wins, and a tie goes to the lower id. */
const supersedes = (candidate, held) =>
  candidate.created_at > held.created_at ||
  (candidate.created_at === held.created_at && candidate.id < held.id);

/**
 * @param {{ gatewayPubkey: string, log?: (line: string) => void }} options
 */
export function createGrantRegistry({ gatewayPubkey, log = () => {} }) {
  /** @type {Map<string, ReturnType<typeof readGrant>>} workload id -> grant */
  const held = new Map();
  /** @type {Map<string, string>} hostname label -> workload id */
  const labels = new Map();

  const ours = gatewayPubkey.toLowerCase();

  const withdraw = (workloadId) => {
    held.delete(workloadId);
    for (const [label, id] of labels) if (id === workloadId) labels.delete(label);
  };

  const ignore = (event, why) => {
    log(`ignored a grant${event?.id ? ` ${event.id}` : ''}: ${why}`);
    return { accepted: false, why };
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

      const current = held.get(grant.workloadId);
      if (current !== undefined && !supersedes(grant.event, current.event)) {
        return ignore(event, `it does not supersede the grant held for ${grant.workloadId}`);
      }

      // A grant naming somebody else is how a tenant ROTATES away from this
      // gateway: the newest grant for a workload decides, and if it is not
      // ours we stop serving that workload rather than keep the old one.
      if (grant.gateway !== ours) {
        if (current !== undefined) {
          withdraw(grant.workloadId);
          log(`workload ${grant.workloadId} was granted to another gateway; no longer served`);
        }
        return ignore(event, `it names another gateway (${grant.gateway})`);
      }

      held.set(grant.workloadId, grant);
      labels.set(canonicalLabel(grant.workloadId), grant.workloadId);
      log(
        `holding a grant for workload ${grant.workloadId} at ` +
          `${canonicalLabel(grant.workloadId)}, until ${new Date(grant.expiresAt * 1000).toISOString()}`,
      );
      return { accepted: true, grant };
    },

    /** The grant served at one hostname label, or `undefined`. */
    find(label) {
      const workloadId = labels.get(label);
      return workloadId === undefined ? undefined : held.get(workloadId);
    },

    /** The grant held for a workload, or `undefined`. */
    forWorkload(workloadId) {
      return held.get(workloadId.toLowerCase());
    },

    /** Every grant held, for a resolver that works through them all. */
    all() {
      return [...held.values()];
    },

    get size() {
      return held.size;
    },
  };
}
