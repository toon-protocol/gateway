// What this gateway holds: one grant per workload, found by hostname.

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { createHeldGrants } from '../src/grants.mjs';
import { canonicalLabel } from '../src/hostname.mjs';
import { CONSTANTS, gatewayGrant } from './helpers/events.mjs';

const GATEWAY = CONSTANTS.gateway.public_key;
const WORKLOAD = 'aa'.repeat(32);
const OTHER = 'bb'.repeat(32);
const label = canonicalLabel(WORKLOAD);

const registry = (log = () => {}) => createHeldGrants({ gatewayPubkey: GATEWAY, log });
const grantFor = (overrides = {}) =>
  gatewayGrant({ workloadId: WORKLOAD, gateway: GATEWAY, ...overrides });

describe('offer', () => {
  it('takes a grant naming this gateway and serves it at its canonical label', () => {
    const grants = registry();
    assert.equal(grants.offer(grantFor()).accepted, true);
    assert.equal(grants.find(label)?.workloadId, WORKLOAD);
    assert.equal(grants.size, 1);
  });

  it('ignores a grant naming another gateway, and says why', () => {
    const lines = [];
    const grants = registry((line) => lines.push(line));
    assert.equal(grants.offer(grantFor({ gateway: 'cc'.repeat(32) })).accepted, false);
    assert.equal(grants.size, 0);
    assert.match(lines.join('\n'), /another gateway|not this gateway/i);
  });

  it('keeps serving a workload whose grant carried an unusable `name`', () => {
    const lines = [];
    const grants = registry((line) => lines.push(line));
    assert.equal(grants.offer(grantFor({ name: 'not a label' })).accepted, true);
    assert.equal(grants.find(label)?.workloadId, WORKLOAD, 'the canonical hostname survives');
    assert.equal(grants.find(label)?.name, undefined);
    assert.match(lines.join('\n'), /name/i);
  });

  it('ignores a malformed grant and keeps serving the rest, saying why', () => {
    const lines = [];
    const grants = registry((line) => lines.push(line));
    grants.offer(grantFor());
    assert.equal(grants.offer({ kind: 30438, tags: [] }).accepted, false);
    assert.equal(grants.find(label)?.workloadId, WORKLOAD, 'the good grant is untouched');
    assert.match(lines.join('\n'), /verif/i);
  });

  it('holds one grant per workload and a separate one per workload', () => {
    const grants = registry();
    grants.offer(grantFor());
    grants.offer(grantFor({ workloadId: OTHER }));
    assert.equal(grants.size, 2);
    assert.equal(grants.find(canonicalLabel(OTHER))?.workloadId, OTHER);
  });

  it('has nothing at a label nobody granted', () => {
    assert.equal(registry().find(canonicalLabel(OTHER)), undefined);
  });
});

describe('replacement', () => {
  it('replaces the grant it holds with a later one for the same workload', () => {
    const grants = registry();
    grants.offer(grantFor({ createdAt: 1700000000, httpPort: 8080 }));
    assert.equal(grants.offer(grantFor({ createdAt: 1700000100, httpPort: 9090 })).accepted, true);
    assert.equal(grants.size, 1, 'a replacement is not a second grant');
    assert.equal(grants.find(label).httpPort, 9090);
  });

  it('keeps the one it holds when an earlier grant arrives out of order', () => {
    const grants = registry();
    grants.offer(grantFor({ createdAt: 1700000100, httpPort: 9090 }));
    assert.equal(grants.offer(grantFor({ createdAt: 1700000000, httpPort: 8080 })).accepted, false);
    assert.equal(grants.find(label).httpPort, 9090);
  });

  it('breaks a created_at tie on the lower id, as NIP-01 does', () => {
    const a = grantFor({ createdAt: 1700000000, httpPort: 8080 });
    const b = grantFor({ createdAt: 1700000000, httpPort: 9090 });
    const [low, high] = a.id < b.id ? [a, b] : [b, a];
    const forwards = registry();
    forwards.offer(low);
    forwards.offer(high);
    const backwards = registry();
    backwards.offer(high);
    backwards.offer(low);
    assert.equal(forwards.find(label).event.id, low.id);
    assert.equal(backwards.find(label).event.id, low.id, 'arrival order does not decide');
  });

  it('ignores the same grant arriving twice, as it will from several relays', () => {
    const grants = registry();
    const grant = grantFor();
    assert.equal(grants.offer(grant).accepted, true);
    assert.equal(grants.offer(grant).accepted, false);
    assert.equal(grants.size, 1);
  });

  it('withdraws a workload when a later grant hands it to another gateway', () => {
    const grants = registry();
    grants.offer(grantFor({ createdAt: 1700000000 }));
    grants.offer(grantFor({ createdAt: 1700000100, gateway: 'cc'.repeat(32) }));
    assert.equal(grants.find(label), undefined, 'the tenant rotated away from this gateway');
    assert.equal(grants.size, 0);
  });

  it('does not let a replayed EARLIER grant undo a rotation away from here', () => {
    // Several relays carry the same grant, so the earlier one arriving again
    // after the rotation is ordinary — and must not put the workload back.
    const grants = registry();
    const mine = grantFor({ createdAt: 1700000000 });
    grants.offer(mine);
    grants.offer(grantFor({ createdAt: 1700000100, gateway: 'cc'.repeat(32) }));
    assert.equal(grants.size, 0);
    grants.offer(mine);
    assert.equal(grants.size, 0, 'the rotation stands');
    assert.equal(grants.find(label), undefined);
  });

  it('keeps a workload when an EARLIER grant named another gateway', () => {
    const grants = registry();
    grants.offer(grantFor({ createdAt: 1700000100 }));
    grants.offer(grantFor({ createdAt: 1700000000, gateway: 'cc'.repeat(32) }));
    assert.equal(grants.find(label)?.workloadId, WORKLOAD);
  });
});

describe('the whole set', () => {
  it('lists what it holds, so a resolver can work through it', () => {
    const grants = registry();
    grants.offer(grantFor());
    grants.offer(grantFor({ workloadId: OTHER }));
    assert.deepEqual(grants.all().map((g) => g.workloadId).sort(), [WORKLOAD, OTHER].sort());
  });
});
