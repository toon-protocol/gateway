// The kind numbers this gateway reads (spec §3.1, ADR 0012).
//
// It WRITES none: after Milestone 6 a gateway publishes nothing and signs
// nothing, and the only events it reads on a workload's account are the
// Provider Profiles of the members its handover names and the Takeover a
// standby publishes (spec §12.1, §12.7). `tests/kinds.test.mjs` pins these
// against the provider's own `constants.json` wire fixture, so a disagreement
// with the reference implementation is a failing test here.

export const K_PROFILE = 10432;
export const K_LIVENESS = 10433;
export const K_TAKEOVER = 30433;

/** The label every published TOON Network event carries (spec §4). */
export const LABEL = 'toon.network';
