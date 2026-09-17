// The canonical hostname of a granted workload (spec §12).
//
// The stable identifier in this protocol is the workload id, not the provider
// running it (ADR 0013), so the name a tenant uses is derived from the
// workload id and from nothing else: the same grant on two gateways gives the
// same label, and a Takeover changes nothing about the name.
//
// Hex would be the obvious encoding and does not fit: a workload id is 32
// bytes, so 64 hex characters, and a DNS label holds 63. Base32 (RFC 4648)
// carries 32 bytes in 52 characters, uses only letters and digits a DNS label
// allows, and is case-insensitive like DNS itself. It is written lowercase and
// unpadded — `=` is not a legal label character, and the padding carries
// nothing, since the length of a workload id is fixed.

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/** RFC 4648 base32 of `bytes`, lowercase and unpadded. */
export function base32Lower(bytes) {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(value >>> bits) & 31];
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/**
 * The 52-character label a workload id is served at.
 *
 * Throws rather than guessing: a workload id that is not 32 bytes of hex is a
 * malformed grant, and a gateway that coerced one would serve a name no
 * tenant can derive.
 */
export function canonicalLabel(workloadId) {
  if (typeof workloadId !== 'string' || !/^[0-9a-fA-F]{64}$/.test(workloadId)) {
    const got = typeof workloadId === 'string' ? JSON.stringify(workloadId) : typeof workloadId;
    throw new Error(`a workload id must be 64 hex characters (32 bytes), not ${got}`);
  }
  return base32Lower(Buffer.from(workloadId.toLowerCase(), 'hex'));
}

/** `<canonical label>.<gateway domain>`, the name this gateway always serves. */
export function hostnameFor(workloadId, domain) {
  return `${canonicalLabel(workloadId)}.${domain.toLowerCase()}`;
}

/**
 * The single label a request's Host sits at under this gateway's domain, or
 * `null` when the host is not one.
 *
 * Only ONE label: `a.b.<domain>` is not this gateway's to serve, and neither
 * is the bare domain. Port, trailing dot and case are DNS's, not the label's.
 */
export function labelUnder(host, domain) {
  if (typeof host !== 'string' || host === '') return null;
  // Strip the port, leaving an IPv6 literal (which is never a label) alone.
  const withoutPort = host.startsWith('[')
    ? host
    : host.replace(/:\d+$/, '');
  const name = withoutPort.toLowerCase().replace(/\.$/, '');
  const suffix = `.${domain.toLowerCase()}`;
  if (!name.endsWith(suffix)) return null;
  const label = name.slice(0, -suffix.length);
  return /^[a-z0-9-]+$/.test(label) ? label : null;
}
