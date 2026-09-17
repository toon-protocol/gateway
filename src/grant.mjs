// The Gateway Grant (spec §3.1.3): the whole of this gateway's authority.
//
// A grant is a tenant's signed delegation naming ONE gateway, ONE workload,
// the workload's HTTP port and its Standby Set, with an expiry. It is what
// this gateway serves a hostname on, and what it hands a provider inside its
// own signed `status` (spec §6.5). It arrives off a relay, so nothing about it
// is taken on trust: the signature is checked here and every field is read
// into a shape the rest of the gateway can use without re-parsing JSON.
//
// A defect is thrown, with a message saying which field: discovery logs it and
// moves on, because one malformed grant must not stop the others being served.

import { K_GATEWAY_GRANT } from './kinds.mjs';
import { isKey32, tagValue, verifyEvent } from './nostr.mjs';

/** A single DNS label: what a readable `name` may be (served at §12.6; `src/grants.mjs`). */
const isLabel = (value) =>
  typeof value === 'string' &&
  value.length >= 1 &&
  value.length <= 63 &&
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(value);

/**
 * Read one event as a Gateway Grant, or throw saying which field is wrong.
 *
 * It does NOT ask whether the grant names THIS gateway: that is a question
 * about who we are rather than about whether the event is a grant, and the
 * registry needs the answer to a grant naming somebody else — a rotation
 * withdraws a workload from this gateway (spec §3.1.3, M5-5) and a grant
 * thrown away here could not.
 *
 * The returned grant keeps its `event`: the signed bytes are what a `status`
 * request carries to a provider (spec §6.5), and re-serialising the content
 * with sorted keys would change the id and make the grant unverifiable.
 */
export function readGrant(event) {
  if (!verifyEvent(event)) {
    throw new Error('its id or signature does not verify');
  }
  if (event.kind !== K_GATEWAY_GRANT) {
    throw new Error(`it is kind ${event.kind}, not a Gateway Grant (kind ${K_GATEWAY_GRANT})`);
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

  const { workload_id: workloadId, gateway, http_port: httpPort, standby_set: standbySet } = content;
  const { expires_at: expiresAt, name } = content;

  if (!isKey32(workloadId)) {
    throw new Error('its `workload_id` is not 64 hex characters');
  }
  if (tagValue(event, 'd') !== workloadId) {
    throw new Error(
      `its \`d\` tag (${tagValue(event, 'd')}) is not its \`workload_id\` (${workloadId})`,
    );
  }
  if (!isKey32(gateway)) {
    throw new Error('its `gateway` is not a pubkey');
  }
  if (!Number.isInteger(httpPort) || httpPort < 1 || httpPort > 65535) {
    throw new Error(`its \`http_port\` is not a port: ${JSON.stringify(httpPort)}`);
  }
  if (!Array.isArray(standbySet) || standbySet.length === 0 || !standbySet.every(isKey32)) {
    throw new Error('its `standby_set` is not a non-empty list of pubkeys');
  }
  if (!Number.isInteger(expiresAt)) {
    throw new Error(`its \`expires_at\` is not a unix time: ${JSON.stringify(expiresAt)}`);
  }
  // A `name` is a convenience, not authority: a bad one costs the workload its
  // readable hostname and nothing else. Throwing here would take the CANONICAL
  // hostname down with it, which is the one a tenant can always derive.
  const nameProblem =
    name === undefined || isLabel(name)
      ? undefined
      : `its \`name\` is not a single DNS label and was dropped: ${JSON.stringify(name)}`;

  return {
    workloadId: workloadId.toLowerCase(),
    gateway: gateway.toLowerCase(),
    httpPort,
    standbySet: standbySet.map((k) => k.toLowerCase()),
    expiresAt,
    name: nameProblem === undefined ? name : undefined,
    /** Why the `name` was dropped, if there was one to drop. */
    nameProblem,
    /** The tenant: the only signer a provider accepts a grant from (spec §6.5). */
    tenant: event.pubkey,
    /** The signed event, unmodified — this is what travels to a provider. */
    event,
    /** `now <= expires_at`, exactly the window a provider applies (spec §6.5). */
    inForceAt: (now) => now <= expiresAt,
  };
}
