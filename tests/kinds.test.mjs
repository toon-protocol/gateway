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
    for (const name of ['K_LEASE_REQUEST', 'K_PROFILE', 'K_LIVENESS', 'K_TAKEOVER', 'K_GATEWAY_GRANT']) {
      assert.equal(kinds[name], constants.kinds[name], name);
    }
  });

  it('agrees on the label every published event carries', () => {
    assert.equal(kinds.LABEL, constants.label);
  });
});
