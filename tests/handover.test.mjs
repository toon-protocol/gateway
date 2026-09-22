// Reading a Gateway Handover: what this gateway will act on, and what it
// throws away.
//
// Nothing read here is TRUSTED — anyone can seal a packet, and no signature
// says otherwise. What these tests pin is that a handover is a handover: the
// shape a tenant's tool must produce, and the defects that never reach a
// provider because they are refused at this gateway's own door.

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { MAX_STANDBY_SET, readHandover } from '../src/messages.mjs';
import { CONSTANTS } from './helpers/events.mjs';
import { gatewayHandover, grantFrom } from './helpers/handover.mjs';

const MEMBER = CONSTANTS.provider.public_key;
const STANDBY = CONSTANTS.standby_provider.public_key;
const WORKLOAD = 'aa'.repeat(32);

const read = (body) => readHandover(body);
const rejection = (body) => {
  assert.throws(() => read(body));
  try {
    read(body);
    return '';
  } catch (e) {
    return e.message;
  }
};
const handoverFor = (overrides = {}) => gatewayHandover({ workloadId: WORKLOAD, ...overrides });
const withField = (field, value) => {
  const body = handoverFor();
  body.handover[field] = value;
  return body;
};

describe('readHandover', () => {
  it('reads what a tenant seals: the workload, its members, the port and the moment', () => {
    const handover = read(handoverFor({ standbySet: [MEMBER, STANDBY], httpPort: 8080 }));
    assert.equal(handover.workloadId, WORKLOAD);
    assert.deepEqual(handover.standbySet, [MEMBER, STANDBY], 'in order, primary first');
    assert.equal(handover.httpPort, 8080);
    assert.equal(handover.expiresAt, CONSTANTS.now + 86_400);
    assert.equal(handover.name, undefined);
  });

  it('carries the grant derived for EACH member, because §6.5.1 derives per member', () => {
    const expiresAt = CONSTANTS.now + 600;
    const handover = read(handoverFor({ standbySet: [MEMBER, STANDBY], expiresAt }));
    assert.equal(handover.grantFor(MEMBER), grantFrom(CONSTANTS.tenant.root_secret, MEMBER, expiresAt));
    assert.equal(handover.grantFor(STANDBY), grantFrom(CONSTANTS.tenant.root_secret, STANDBY, expiresAt));
    assert.notEqual(handover.grantFor(MEMBER), handover.grantFor(STANDBY));
  });

  it('refuses a body that is not `{ "handover": … }` and nothing else', () => {
    assert.match(rejection(null), /JSON object/);
    assert.match(rejection([handoverFor()]), /JSON object/);
    assert.match(rejection(handoverFor().handover), /handover/);
    assert.match(rejection({ ...handoverFor(), extra: 1 }), /handover/);
  });

  it('refuses a workload id that is not 32 bytes of hex', () => {
    assert.match(rejection(withField('workload_id', 'ab')), /workload_id/);
  });

  it('refuses a standby set that is not a non-empty list of members', () => {
    for (const standbySet of [[], 'x', null, 7]) {
      assert.match(rejection(withField('standby_set', standbySet)), /standby_set/, JSON.stringify(standbySet));
    }
  });

  it('refuses a member with no `provider`, no `grant`, or a field nobody names', () => {
    const grant = 'cd'.repeat(32);
    assert.match(rejection(withField('standby_set', [{ grant }])), /provider/);
    assert.match(rejection(withField('standby_set', [{ provider: MEMBER }])), /grant/);
    assert.match(rejection(withField('standby_set', [{ provider: MEMBER, grant: 'nope' }])), /grant/);
    assert.match(rejection(withField('standby_set', [MEMBER])), /JSON object/);
    assert.match(
      rejection(withField('standby_set', [{ provider: MEMBER, grant, gateway: MEMBER }])),
      /gateway/,
    );
  });

  it('refuses a standby set that names one provider twice', () => {
    const grant = 'cd'.repeat(32);
    assert.match(
      rejection(withField('standby_set', [{ provider: MEMBER, grant }, { provider: MEMBER, grant }])),
      /twice/,
    );
  });

  it('refuses a standby set larger than this gateway will ask', () => {
    const many = Array.from({ length: MAX_STANDBY_SET + 1 }, (_, i) => ({
      provider: i.toString(16).padStart(2, '0').repeat(32),
      grant: 'cd'.repeat(32),
    }));
    assert.match(rejection(withField('standby_set', many)), /standby_set/);
  });

  it('refuses an http_port that is not a port', () => {
    for (const httpPort of [0, 70000, 8080.5, '8080', null]) {
      assert.match(rejection(withField('http_port', httpPort)), /http_port/, String(httpPort));
    }
  });

  it('refuses an expires_at that is not a unix time', () => {
    assert.match(rejection(withField('expires_at', 'soon')), /expires_at/);
  });

  it('refuses a field no handover names, rather than dropping it', () => {
    assert.match(rejection(withField('gateway', MEMBER)), /gateway/);
    assert.match(rejection(withField('grant', 'cd'.repeat(32))), /grant/);
  });

  it('drops a `name` that is not one DNS label, and keeps the rest of the handover', () => {
    // A bad `name` must not cost the workload its CANONICAL hostname, which is
    // the one a tenant can always derive (§12.6).
    for (const name of ['not a label', 'a.b', '-lead', 'x'.repeat(64), '', 5]) {
      const handover = read(handoverFor({ name }));
      assert.equal(handover.name, undefined, JSON.stringify(name));
      assert.match(handover.nameProblem, /name/i, JSON.stringify(name));
      assert.equal(handover.workloadId, WORKLOAD, 'the handover itself survives');
    }
  });

  it('carries a good `name` with no complaint', () => {
    const handover = read(handoverFor({ name: 'shop' }));
    assert.equal(handover.name, 'shop');
    assert.equal(handover.nameProblem, undefined);
  });
});

describe('grant expiry', () => {
  it('knows whether it is in force at a given moment', () => {
    const handover = read(handoverFor({ expiresAt: 1000 }));
    assert.equal(handover.inForceAt(999), true);
    assert.equal(handover.inForceAt(1000), true, 'now <= expires_at is in force (spec §6.5.1)');
    assert.equal(handover.inForceAt(1001), false);
  });
});
