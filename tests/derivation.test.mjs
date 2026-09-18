// The Gateway Grant derivation, pinned to the provider's own vectors.
//
// A gateway derives nothing — the tenant does (spec §6.5.1) — but every test
// here hands it a grant, and a grant derived the wrong way would make those
// tests agree with themselves and with nothing else. So the derivation the
// helpers use is checked against the reference implementation's fixtures, in
// both halves: the lease's token, and the grant that token derives.

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { CONSTANTS, wireFixture } from './helpers/events.mjs';
import { continuationFor, gatewaySub } from './helpers/handover.mjs';

describe('continuation(provider)', () => {
  it('derives the token the provider stores for the fixture lease', () => {
    assert.equal(
      continuationFor(CONSTANTS.tenant.root_secret, CONSTANTS.provider.public_key),
      CONSTANTS.tenant.continuation_at_provider,
    );
  });

  it('derives a DIFFERENT token per provider, which is the point (spec §6.1.1)', () => {
    const root = CONSTANTS.tenant.root_secret;
    assert.notEqual(
      continuationFor(root, CONSTANTS.provider.public_key),
      continuationFor(root, CONSTANTS.standby_provider.public_key),
    );
  });
});

describe('gateway_sub(provider, expires_at)', () => {
  const vector = wireFixture('gateway_sub.vector');

  it('derives the fixture grant for the fixture moment', () => {
    assert.equal(gatewaySub(vector.continuation, vector.expires_at), vector.gateway_sub);
  });

  it('derives a different grant one second later, which is why rotation is re-derivation', () => {
    assert.equal(
      gatewaySub(vector.continuation, vector.at_the_next_second.expires_at),
      vector.at_the_next_second.gateway_sub,
    );
  });

  it('is what the delegated `status` fixture presents as its `continuation`', () => {
    const delegated = wireFixture('status.delegated').request_body.request;
    assert.equal(
      delegated.continuation,
      gatewaySub(CONSTANTS.tenant.continuation_at_provider, delegated.content.gateway_expires_at),
    );
  });
});
