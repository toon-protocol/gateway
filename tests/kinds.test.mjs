// The kind numbers, pinned to the provider's fixtures rather than to memory.

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';

import * as kinds from '../src/kinds.mjs';

const constants = JSON.parse(
  readFileSync(new URL('./fixtures/wire/constants.json', import.meta.url), 'utf8'),
);

describe('kinds', () => {
  it('agrees with the provider on every kind this gateway names', () => {
    for (const name of ['K_PROFILE', 'K_LIVENESS', 'K_TAKEOVER']) {
      assert.equal(kinds[name], constants.kinds[name], name);
    }
  });

  it('names no kind the provider has returned to its block\'s free range', () => {
    // `4432` and `30438` are gone (spec §3.1, ADR 0016): a Lease Request is
    // not an event and a Gateway Grant is not published. A gateway that still
    // named either would be filtering for something nobody writes.
    for (const gone of ['K_LEASE_REQUEST', 'K_GATEWAY_GRANT']) {
      assert.equal(kinds[gone], undefined, gone);
      assert.equal(constants.kinds[gone], undefined, gone);
    }
  });

  it('agrees on the label every published event carries', () => {
    assert.equal(kinds.LABEL, constants.label);
  });
});
