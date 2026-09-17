// NIP-01 events, as much of them as a gateway needs.
//
// A gateway reads grants off relays and signs `status` requests with its own
// key (spec §6.5), and a relay is not trusted: every event this gateway acts
// on has its `id` re-derived and its `sig` checked here first. Nothing TOON-
// specific is hashed or signed (spec §6.1.1), so this is plain NIP-01.

import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

const isHex = (value, bytes) =>
  typeof value === 'string' && new RegExp(`^[0-9a-f]{${bytes * 2}}$`, 'i').test(value);

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

/** The x-only public key of a 32-byte hex secret key. */
export function publicKeyOf(secretKey) {
  if (!isHex(secretKey, 32)) {
    throw new Error('a Nostr secret key must be 64 hex characters (32 bytes)');
  }
  return bytesToHex(schnorr.getPublicKey(hexToBytes(secretKey.toLowerCase())));
}

/**
 * A signed event: `{ kind, created_at, tags, content }` plus this key's
 * pubkey, the derived id and the signature over it.
 */
export function signEvent(secretKey, { kind, created_at, tags = [], content = '' }) {
  const unsigned = { pubkey: publicKeyOf(secretKey), created_at, kind, tags, content };
  const id = eventId(unsigned);
  return {
    ...unsigned,
    id,
    sig: bytesToHex(schnorr.sign(hexToBytes(id), hexToBytes(secretKey.toLowerCase()))),
  };
}

/** The value of the first `name` tag, or `undefined`. */
export function tagValue(event, name) {
  const tag = event.tags?.find((t) => Array.isArray(t) && t[0] === name);
  return tag === undefined ? undefined : tag[1];
}
