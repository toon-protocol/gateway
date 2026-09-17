// The canonical hostname: the one name a granted workload is always served at.
//
// It is derived, never assigned, so nothing has to be told to this gateway
// out of band and two gateways holding the same grant serve the same label.

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { base32Lower, canonicalLabel, hostnameFor, labelUnder } from '../src/hostname.mjs';

describe('base32Lower', () => {
  // RFC 4648 §10, lowercased and unpadded.
  it('matches the RFC 4648 test vectors without padding', () => {
    const vectors = [
      ['', ''],
      ['f', 'my'],
      ['fo', 'mzxq'],
      ['foo', 'mzxw6'],
      ['foob', 'mzxw6yq'],
      ['fooba', 'mzxw6ytb'],
      ['foobar', 'mzxw6ytboi'],
    ];
    for (const [input, expected] of vectors) {
      assert.equal(base32Lower(Buffer.from(input, 'utf8')), expected, input);
    }
  });
});

describe('canonicalLabel', () => {
  it('turns a known workload id into its known label', () => {
    // The wire fixtures' workload id (32 bytes of 0xaa), independently
    // encoded: base64.b32encode(b'\xaa' * 32).lower().rstrip('=').
    assert.equal(
      canonicalLabel('aa'.repeat(32)),
      'vkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkva',
    );
    assert.equal(
      canonicalLabel('0123456789abcdef'.repeat(4)),
      'aerukz4jvpg66ajdivtytk6n54asgrlhrgv433ybencwpcnlzxxq',
    );
  });

  it('is 52 characters, which fits a DNS label where 64 hex would not', () => {
    const label = canonicalLabel('aa'.repeat(32));
    assert.equal(label.length, 52);
    assert.ok(label.length <= 63);
    assert.match(label, /^[a-z2-7]{52}$/);
  });

  it('reads a workload id in either case and answers the same label', () => {
    assert.equal(canonicalLabel('AA'.repeat(32)), canonicalLabel('aa'.repeat(32)));
  });

  it('refuses anything that is not a 32-byte hex workload id', () => {
    assert.throws(() => canonicalLabel('aa'.repeat(31)), /64 hex/);
    assert.throws(() => canonicalLabel('zz'.repeat(32)), /64 hex/);
    assert.throws(() => canonicalLabel(''), /64 hex/);
  });
});

describe('hostnameFor', () => {
  it('serves the canonical label under the gateway domain, lowercased', () => {
    assert.equal(
      hostnameFor('aa'.repeat(32), 'Gw.Example'),
      'vkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkva.gw.example',
    );
  });
});

describe('labelUnder', () => {
  it('takes the label out of a Host header, port and case and all', () => {
    assert.equal(labelUnder('ABC.gw.example:8443', 'gw.example'), 'abc');
    assert.equal(labelUnder('abc.gw.example.', 'gw.example'), 'abc');
    assert.equal(labelUnder('[::1]:8443', 'gw.example'), null);
  });

  it('is null for a host that is not one label under this gateway', () => {
    assert.equal(labelUnder('gw.example', 'gw.example'), null);
    assert.equal(labelUnder('a.b.gw.example', 'gw.example'), null);
    assert.equal(labelUnder('abc.elsewhere.example', 'gw.example'), null);
    assert.equal(labelUnder('', 'gw.example'), null);
    assert.equal(labelUnder(undefined, 'gw.example'), null);
  });
});
