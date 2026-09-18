// The Gateway Handover (spec §12.1): the whole of this gateway's authority.
//
// A tenant chooses a gateway by SEALING ONE PACKET to its connector — there is
// nothing published to find any more, and nothing signed to check. The message
// carries what the removed grant event's content carried, because the gateway
// needs all of it and can no longer read it anywhere: the workload id, the
// Standby Set with the primary first, which of the spawn's ports is the HTTP
// one, the moment the grants were derived for, and an optional readable name.
//
// A GRANT PER MEMBER, and it could not be otherwise. A Gateway Grant derives
// from `continuation(provider)` (spec §6.5.1), which derives under the
// member's own key, so the value that admits this gateway at the primary
// admits it nowhere else. §12.4 asks EVERY member at once, so a handover
// carrying one value could reach exactly one of them — which is why each entry
// of `standby_set` carries the grant derived for that member, at the one
// `expires_at` they share.
//
// NOTHING HERE ESTABLISHES AUTHORITY. Anyone can seal a packet, so this module
// answers only "is this a handover at all" — whether the grant WORKS is asked
// empirically, by sending `status` to the members it names (`src/admit.mjs`).
// A defect is thrown with a message saying which field: admission logs it and
// drops the handover, because one malformed packet must never disturb the
// workloads already being served.
//
// The `grant` is a SECRET (spec §6.1.1): it is never logged, never put in a
// message, and never handed to anybody but the members this handover names.

import { isKey32 } from './nostr.mjs';

/** Where a gateway's connector forwards a sealed handover (spec §12.1). */
export const HANDOVER_PATH = '/handover';

/**
 * The most members one handover may name.
 *
 * It is the amplification bound (spec §12.1): one sealed packet buys one free
 * `status` per member named, so without a cap a stranger could name a thousand
 * providers and have this gateway send a thousand requests for one packet.
 */
export const MAX_STANDBY_SET = 16;

/** A single DNS label: what a readable `name` may be (served at §12.6). */
const isLabel = (value) =>
  typeof value === 'string' &&
  value.length >= 1 &&
  value.length <= 63 &&
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(value);

const KEYS = ['workload_id', 'standby_set', 'http_port', 'expires_at', 'name'];
const MEMBER_KEYS = ['provider', 'grant'];

/**
 * Read a request body as a Gateway Handover, or throw saying what is wrong.
 *
 * The body is `{ "handover": … }`, one key and no other, exactly as a Lease
 * Request's body is `{ "request": … }` (spec §6.1.2): the gateway's connector
 * unseals the envelope and forwards plain HTTP, so what arrives here is
 * plaintext JSON.
 */
export function readHandover(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('the body is not a JSON object');
  }
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== 'handover') {
    throw new Error('the body is not `{ "handover": … }` and nothing else');
  }
  const handover = body.handover;
  if (handover === null || typeof handover !== 'object' || Array.isArray(handover)) {
    throw new Error('its `handover` is not a JSON object');
  }
  // A field this spec does not name is refused rather than dropped (ADR 0004),
  // so a tenant that meant something by it learns that nobody read it.
  const unknown = Object.keys(handover).filter((key) => !KEYS.includes(key));
  if (unknown.length > 0) {
    throw new Error(`it carries a field no handover names: ${unknown.join(', ')}`);
  }

  const { workload_id: workloadId, standby_set: members, http_port: httpPort } = handover;
  const { expires_at: expiresAt, name } = handover;

  if (!isKey32(workloadId)) {
    throw new Error('its `workload_id` is not 64 hex characters');
  }
  if (!Array.isArray(members) || members.length === 0) {
    throw new Error('its `standby_set` is not a non-empty list of members');
  }
  if (members.length > MAX_STANDBY_SET) {
    throw new Error(
      `its \`standby_set\` names ${members.length} members; this gateway asks at most ` +
        `${MAX_STANDBY_SET} from one handover`,
    );
  }

  /** @type {Map<string, string>} member pubkey -> the grant derived for it */
  const grants = new Map();
  /** @type {string[]} `standby_set` order, primary first (spec §7, §12.4). */
  const standbySet = [];
  for (const [index, member] of members.entries()) {
    if (member === null || typeof member !== 'object' || Array.isArray(member)) {
      throw new Error(`its \`standby_set\` entry ${index} is not a JSON object`);
    }
    const unknownHere = Object.keys(member).filter((key) => !MEMBER_KEYS.includes(key));
    if (unknownHere.length > 0) {
      throw new Error(
        `its \`standby_set\` entry ${index} carries a field no member names: ${unknownHere.join(', ')}`,
      );
    }
    if (!isKey32(member.provider)) {
      throw new Error(`its \`standby_set\` entry ${index} has no \`provider\` pubkey`);
    }
    if (!isKey32(member.grant)) {
      throw new Error(
        `its \`standby_set\` entry ${index} has no \`grant\` of 64 hex characters; every member ` +
          'needs the grant derived for its own key (spec §6.5.1)',
      );
    }
    const provider = member.provider.toLowerCase();
    if (grants.has(provider)) {
      throw new Error(`its \`standby_set\` names ${provider} twice`);
    }
    grants.set(provider, member.grant.toLowerCase());
    standbySet.push(provider);
  }

  if (!Number.isInteger(httpPort) || httpPort < 1 || httpPort > 65535) {
    throw new Error(`its \`http_port\` is not a port: ${JSON.stringify(httpPort)}`);
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
    standbySet,
    httpPort,
    expiresAt,
    /** The Gateway Grant derived for one member (spec §6.5.1). A SECRET: never log it. */
    grantFor: (member) => grants.get(member),
    name: nameProblem === undefined ? name : undefined,
    /** Why the `name` was dropped, if there was one to drop. */
    nameProblem,
    /** `now <= expires_at`, exactly the window a provider applies (spec §6.5.1). */
    inForceAt: (now) => now <= expiresAt,
  };
}
