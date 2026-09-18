// NIP-01 events, as much of them as a gateway needs — which is the READING
// half and no more.
//
// A gateway signs nothing and publishes nothing (spec §12.1), and holds no
// Nostr key at all. What it reads off a relay is a member's Provider Profile
// and a standby's Takeover, and a relay is not trusted: every event this
// gateway acts on has its `id` re-derived and its `sig` checked here first.
// Nothing TOON-specific is hashed or signed, so this is plain NIP-01.
//
// The signing half lives in `tests/helpers/sign.mjs`, because forging the
// events a gateway reads is something only the tests do.

import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

/** A lowercase-or-uppercase hex string of exactly `bytes` bytes. */
export const isHex = (value, bytes) =>
  typeof value === 'string' && new RegExp(`^[0-9a-f]{${bytes * 2}}$`, 'i').test(value);

/**
 * A 32-byte hex identifier: a Nostr pubkey, an event id's worth of bytes, or a
 * workload id — which are the same shape, and are checked in the same places.
 */
export const isKey32 = (value) => isHex(value, 32);

/** The NIP-01 serialization an event's id is the SHA-256 of. */
export function serializeEvent(event) {
  return JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content,
  ]);
}

/** An event's id, re-derived from its own fields. */
export function eventId(event) {
  return bytesToHex(sha256(new TextEncoder().encode(serializeEvent(event))));
}

/**
 * Whether an event is really what it says it is: the id matches the content
 * and the signature is the pubkey's over that id.
 *
 * Never throws — a relay may send anything at all, and a gateway that crashed
 * on a malformed event would be taken down by any client of that relay.
 */
export function verifyEvent(event) {
  try {
    if (event === null || typeof event !== 'object') return false;
    if (!isHex(event.id, 32) || !isHex(event.pubkey, 32) || !isHex(event.sig, 64)) return false;
    if (!Number.isInteger(event.kind) || !Number.isInteger(event.created_at)) return false;
    if (typeof event.content !== 'string' || !Array.isArray(event.tags)) return false;
    if (eventId(event) !== event.id.toLowerCase()) return false;
    return schnorr.verify(hexToBytes(event.sig), hexToBytes(event.id), hexToBytes(event.pubkey));
  } catch {
    return false;
  }
}

/** The value of the first `name` tag, or `undefined`. */
export function tagValue(event, name) {
  const tag = event.tags?.find((t) => Array.isArray(t) && t[0] === name);
  return tag === undefined ? undefined : tag[1];
}
