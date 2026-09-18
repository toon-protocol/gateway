// The two messages a tenant seals to a gateway: the Gateway Handover (spec
// §12.1), which is the whole of this gateway's authority, and the Gateway
// Withdrawal (spec §12.7), which ends it serving a workload.
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
// A WITHDRAWAL IS THE SAME MEMBERS, and deliberately so: it names the workload
// and bears, for each member, the grant derived for that member's own key at
// the moment the handover named. A gateway that can read one message has
// learned to read the other, and `readMembers` below is the one place either
// is read. What a withdrawal does NOT carry is an `http_port` or a `name`:
// there is nothing left to serve, so there is nothing to serve it on.
//
// The `grant` is a SECRET (spec §6.1.1): it is never logged, never put in a
// message, and never handed to anybody but the members these messages name.

import { isKey32 } from './nostr.mjs';

/** Where a gateway's connector forwards a sealed handover (spec §12.1). */
export const HANDOVER_PATH = '/handover';

/**
 * The most members one sealed message may name.
 *
 * It is the amplification bound (spec §12.1): one sealed packet buys one free
 * `status` per member named, so without a cap a stranger could name a thousand
 * providers and have this gateway send a thousand requests for one packet. A
 * withdrawal asks nobody, and is held to the same bound because there is no
 * reason for it to name more members than the handover it undoes.
 */
export const MAX_STANDBY_SET = 16;

/** A single DNS label: what a readable `name` may be (served at §12.6). */
const isLabel = (value) =>
  typeof value === 'string' &&
  value.length >= 1 &&
  value.length <= 63 &&
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(value);

const HANDOVER_KEYS = ['workload_id', 'standby_set', 'http_port', 'expires_at', 'name'];
const WITHDRAWAL_KEYS = ['workload_id', 'standby_set', 'expires_at'];
const MEMBER_KEYS = ['provider', 'grant'];

/**
 * Whether this body NAMES a withdrawal.
 *
 * It lives beside the keys themselves, because which key names which message
 * is one fact and the door that routes on it must not hold a second copy
 * (`src/door.mjs`). It answers only which READER to hand the body to; whether
 * the body is a withdrawal at all is that reader's answer, which is why a body
 * carrying `withdrawal` AND something else comes here rather than going to
 * admission: a sender that said "withdrawal" is told what is wrong with its
 * withdrawal.
 */
export const namesWithdrawal = (body) =>
  body !== null && typeof body === 'object' && !Array.isArray(body) && Object.hasOwn(body, 'withdrawal');

/**
 * The one message under `key`, or throw saying what is wrong.
 *
 * The body is `{ "handover": … }` or `{ "withdrawal": … }`, one key and no
 * other, exactly as a Lease Request's body is `{ "request": … }` (spec
 * §6.1.2): the gateway's connector unseals the envelope and forwards plain
 * HTTP, so what arrives here is plaintext JSON.
 */
function readMessage(body, key, keys) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('the body is not a JSON object');
  }
  const outer = Object.keys(body);
  if (outer.length !== 1 || outer[0] !== key) {
    throw new Error(`the body is not \`{ "${key}": … }\` and nothing else`);
  }
  const message = body[key];
  if (message === null || typeof message !== 'object' || Array.isArray(message)) {
    throw new Error(`its \`${key}\` is not a JSON object`);
  }
  // A field this spec does not name is refused rather than dropped (ADR 0004),
  // so a tenant that meant something by it learns that nobody read it.
  const unknown = Object.keys(message).filter((field) => !keys.includes(field));
  if (unknown.length > 0) {
    throw new Error(`it carries a field no ${key} names: ${unknown.join(', ')}`);
  }
  return message;
}

/**
 * The `standby_set` both messages carry: the members in their own order,
 * primary first (spec §7, §12.4), each with the grant derived for its own key.
 *
 * @returns {{ standbySet: string[], grantFor: (member: string) => string | undefined }}
 */
function readMembers(members) {
  if (!Array.isArray(members) || members.length === 0) {
    throw new Error('its `standby_set` is not a non-empty list of members');
  }
  if (members.length > MAX_STANDBY_SET) {
    throw new Error(
      `its \`standby_set\` names ${members.length} members; one sealed message may name at ` +
        `most ${MAX_STANDBY_SET} (spec §12.1)`,
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

  return {
    standbySet,
    /** The Gateway Grant derived for one member (spec §6.5.1). A SECRET: never log it. */
    grantFor: (member) => grants.get(member),
  };
}

/**
 * Read a request body as a Gateway Handover, or throw saying what is wrong.
 */
export function readHandover(body) {
  const handover = readMessage(body, 'handover', HANDOVER_KEYS);

  const { workload_id: workloadId, standby_set: members, http_port: httpPort } = handover;
  const { expires_at: expiresAt, name } = handover;

  if (!isKey32(workloadId)) {
    throw new Error('its `workload_id` is not 64 hex characters');
  }
  const { standbySet, grantFor } = readMembers(members);

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
    grantFor,
    name: nameProblem === undefined ? name : undefined,
    /** Why the `name` was dropped, if there was one to drop. */
    nameProblem,
    /** `now <= expires_at`, exactly the window a provider applies (spec §6.5.1). */
    inForceAt: (now) => now <= expiresAt,
  };
}

/**
 * Read a request body as a Gateway Withdrawal, or throw saying what is wrong.
 *
 * `expires_at` says WHICH grant this withdrawal bears — the moment the
 * handover named, under which the values in `standby_set` were derived — and
 * it is NOT compared with the clock here or anywhere else (spec §12.7). A
 * withdrawal of a grant that has already run out is an ordinary withdrawal: it
 * still frees the workload's names, which an expired grant is still holding.
 */
export function readWithdrawal(body) {
  const withdrawal = readMessage(body, 'withdrawal', WITHDRAWAL_KEYS);

  const { workload_id: workloadId, standby_set: members, expires_at: expiresAt } = withdrawal;

  if (!isKey32(workloadId)) {
    throw new Error('its `workload_id` is not 64 hex characters');
  }
  const { standbySet, grantFor } = readMembers(members);
  if (!Number.isInteger(expiresAt)) {
    throw new Error(`its \`expires_at\` is not a unix time: ${JSON.stringify(expiresAt)}`);
  }

  return { workloadId: workloadId.toLowerCase(), standbySet, expiresAt, grantFor };
}
