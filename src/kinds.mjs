// The kind numbers this gateway reads and writes (spec §3.1, ADR 0012).
//
// One place, never a literal at a call site: a filter that hard-codes 30438
// is a filter nobody can find when the allocation moves. `tests/kinds.test.mjs`
// pins these against the provider's own `constants.json` wire fixture, so a
// disagreement with the reference implementation is a failing test here.

export const K_LEASE_REQUEST = 4432;
export const K_PROFILE = 10432;
export const K_LIVENESS = 10433;
export const K_TAKEOVER = 30433;
export const K_GATEWAY_GRANT = 30438;

/** The label every published TOON Network event carries (spec §4). */
export const LABEL = 'toon.network';
