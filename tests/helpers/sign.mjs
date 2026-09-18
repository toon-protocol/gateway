// Signing, which only the tests do.
//
// A gateway signs nothing and publishes nothing (spec §12.1), so `src/` holds
// the verifying half of NIP-01 and no more. What the tests need is the other
// half: the Provider Profiles and Takeovers a gateway READS have to be forged
// from somewhere, and this is that somewhere.

import { schnorr } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

import { eventId, isHex } from '../../src/nostr.mjs';

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
