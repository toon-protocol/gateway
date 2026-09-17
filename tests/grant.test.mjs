// Reading a Gateway Grant off a relay: what this gateway will act on, and
// what it throws away. A relay is not trusted; the tenant's signature is.

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { readGrant } from '../src/grant.mjs';
import { signEvent } from '../src/nostr.mjs';
import { K_GATEWAY_GRANT, LABEL } from '../src/kinds.mjs';
import { CONSTANTS, gatewayGrant, wireFixture } from './helpers/events.mjs';

const GATEWAY = CONSTANTS.gateway.public_key;
const WORKLOAD = 'aa'.repeat(32);
const read = (event) => readGrant(event);
const rejection = (event) => {
  assert.throws(() => read(event));
  try {
    read(event);
    return '';
  } catch (e) {
    return e.message;
  }
};

describe('readGrant', () => {
  it('reads the provider-generated fixture grant', () => {
    const grant = read(wireFixture('gateway_grant').event);
    assert.equal(grant.workloadId, WORKLOAD);
    assert.equal(grant.gateway, GATEWAY);
    assert.equal(grant.httpPort, 443);
    assert.deepEqual(grant.standbySet, [CONSTANTS.provider.public_key]);
    assert.equal(grant.expiresAt, 1700086400);
    assert.equal(grant.tenant, CONSTANTS.tenant.public_key);
    assert.equal(grant.name, undefined);
    assert.equal(grant.event.id, wireFixture('gateway_grant').event.id);
  });

  it('carries `name` on the wire without acting on it', () => {
    const grant = read(gatewayGrant({ workloadId: WORKLOAD, gateway: GATEWAY, name: 'shop' }));
    assert.equal(grant.name, 'shop');
  });

  it('refuses a grant whose signature does not verify', () => {
    const forged = { ...gatewayGrant({ workloadId: WORKLOAD, gateway: GATEWAY }), sig: '0'.repeat(128) };
    assert.match(rejection(forged), /signature|verify/i);
  });

  it('refuses a grant of another kind', () => {
    const notAGrant = { ...wireFixture('directory.takeover').event };
    assert.match(rejection(notAGrant), /kind/i);
  });

  it('reads a grant naming another gateway rather than discarding it', () => {
    // Whose grant it is belongs to the registry: a rotation to another gateway
    // is how a workload leaves this one (M5-5), and it arrives as a grant.
    const elsewhere = read(gatewayGrant({ workloadId: WORKLOAD, gateway: 'b'.repeat(64) }));
    assert.equal(elsewhere.gateway, 'b'.repeat(64));
  });

  it('refuses a properly signed grant whose `d` tag and content workload id disagree', () => {
    const split = signEvent(CONSTANTS.tenant.secret_key, {
      kind: K_GATEWAY_GRANT,
      created_at: CONSTANTS.now,
      tags: [['d', 'bb'.repeat(32)], ['p', GATEWAY], ['L', LABEL]],
      content: JSON.stringify({
        workload_id: WORKLOAD,
        gateway: GATEWAY,
        http_port: 8080,
        standby_set: [CONSTANTS.provider.public_key],
        expires_at: CONSTANTS.now + 60,
      }),
    });
    assert.match(rejection(split), /workload id|`d`/i);
  });

  it('refuses a workload id that is not 32 bytes of hex', () => {
    assert.match(rejection(gatewayGrant({ workloadId: 'ab', gateway: GATEWAY })), /workload_id/i);
  });

  it('refuses an http_port that is not a port', () => {
    for (const httpPort of [0, 70000, 8080.5, '8080', null]) {
      assert.match(
        rejection(gatewayGrant({ workloadId: WORKLOAD, gateway: GATEWAY, httpPort })),
        /http_port/i,
        String(httpPort),
      );
    }
  });

  it('refuses a standby set that is not a non-empty list of pubkeys', () => {
    for (const standbySet of [[], ['nope'], 'x', null, [CONSTANTS.provider.public_key, 'nope']]) {
      assert.match(
        rejection(gatewayGrant({ workloadId: WORKLOAD, gateway: GATEWAY, standbySet })),
        /standby_set/i,
        JSON.stringify(standbySet),
      );
    }
  });

  it('refuses an expires_at that is not a unix time', () => {
    assert.match(
      rejection(gatewayGrant({ workloadId: WORKLOAD, gateway: GATEWAY, expiresAt: 'soon' })),
      /expires_at/i,
    );
  });

  it('refuses a `name` that is not one DNS label, without touching the rest', () => {
    for (const name of ['not a label', 'a.b', '-lead', 'x'.repeat(64), '', 5]) {
      assert.match(
        rejection(gatewayGrant({ workloadId: WORKLOAD, gateway: GATEWAY, name })),
        /name/i,
        JSON.stringify(name),
      );
    }
  });

  it('refuses a properly signed grant whose content is not JSON at all', () => {
    const nonsense = signEvent(CONSTANTS.tenant.secret_key, {
      kind: K_GATEWAY_GRANT,
      created_at: CONSTANTS.now,
      tags: [['d', WORKLOAD], ['p', GATEWAY], ['L', LABEL]],
      content: 'nonsense',
    });
    assert.match(rejection(nonsense), /content|JSON/i);
  });
});

describe('grant expiry', () => {
  it('knows whether it is in force at a given moment', () => {
    const grant = read(gatewayGrant({ workloadId: WORKLOAD, gateway: GATEWAY, expiresAt: 1000 }));
    assert.equal(grant.inForceAt(999), true);
    assert.equal(grant.inForceAt(1000), true, 'now <= expires_at is in force (spec §6.5)');
    assert.equal(grant.inForceAt(1001), false);
  });
});
