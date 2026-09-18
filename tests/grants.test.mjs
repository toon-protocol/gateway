// What this gateway holds: one grant per workload, found by hostname.

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { createHeldGrants } from '../src/grants.mjs';
import { readHandover } from '../src/handover.mjs';
import { canonicalLabel } from '../src/hostname.mjs';
import { CONSTANTS } from './helpers/events.mjs';
import { gatewayHandover } from './helpers/handover.mjs';

const WORKLOAD = 'aa'.repeat(32);
const OTHER = 'bb'.repeat(32);
const label = canonicalLabel(WORKLOAD);

const registry = (log = () => {}) => createHeldGrants({ now: () => CONSTANTS.now, log });
const grantFor = (overrides = {}) =>
  readHandover(gatewayHandover({ workloadId: WORKLOAD, ...overrides }));

describe('hold', () => {
  it('serves an admitted handover at its canonical label', () => {
    const grants = registry();
    grants.hold(grantFor());
    assert.equal(grants.find(label)?.workloadId, WORKLOAD);
    assert.equal(grants.size, 1);
  });

  it('keeps serving a workload whose handover carried an unusable `name`', () => {
    const lines = [];
    const grants = registry((line) => lines.push(line));
    grants.hold(grantFor({ name: 'not a label' }));
    assert.equal(grants.find(label)?.workloadId, WORKLOAD, 'the canonical hostname survives');
    assert.equal(grants.find(label)?.name, undefined);
    assert.match(lines.join('\n'), /name/i);
  });

  it('holds a separate grant per workload', () => {
    const grants = registry();
    grants.hold(grantFor());
    grants.hold(grantFor({ workloadId: OTHER }));
    assert.equal(grants.size, 2);
    assert.equal(grants.find(canonicalLabel(OTHER))?.workloadId, OTHER);
  });

  it('has nothing at a label nobody handed over', () => {
    assert.equal(registry().find(canonicalLabel(OTHER)), undefined);
  });
});

describe('replacement', () => {
  it('replaces the grant it holds with a later handover for the same workload', () => {
    // Admission is what decided this handover may replace the one held: only
    // the holder of the lease's Continuation Token can derive a grant a member
    // takes (spec §12.1), so there is nothing further to weigh here.
    const grants = registry();
    grants.hold(grantFor({ httpPort: 8080 }));
    grants.hold(grantFor({ httpPort: 9090 }));
    assert.equal(grants.size, 1, 'a replacement is not a second grant');
    assert.equal(grants.find(label).httpPort, 9090);
  });

  it('gives up a name the workload no longer asks for', () => {
    const grants = registry();
    grants.hold(grantFor({ name: 'shop' }));
    assert.equal(grants.find('shop')?.workloadId, WORKLOAD);
    grants.hold(grantFor());
    assert.equal(grants.find('shop'), undefined);
  });
});

describe('a readable name', () => {
  it('is first come, first served, and costs the loser nothing else', () => {
    const lines = [];
    const grants = registry((line) => lines.push(line));
    grants.hold(grantFor({ name: 'shop' }));
    grants.hold(grantFor({ workloadId: OTHER, name: 'shop' }));

    assert.equal(grants.find('shop')?.workloadId, WORKLOAD);
    assert.equal(grants.find(canonicalLabel(OTHER))?.workloadId, OTHER, 'both stay canonical');
    assert.match(lines.join('\n'), /shop/);
  });

  it('never takes a canonical hostname from the workload that derives it', () => {
    const grants = registry();
    grants.hold(grantFor());
    grants.hold(grantFor({ workloadId: OTHER, name: label }));
    assert.equal(grants.find(label)?.workloadId, WORKLOAD);
  });

  it('passes to a later grant once the one holding it is out of force', () => {
    const grants = registry();
    grants.hold(grantFor({ name: 'shop', expiresAt: CONSTANTS.now - 1 }));
    grants.hold(grantFor({ workloadId: OTHER, name: 'shop' }));
    assert.equal(grants.find('shop')?.workloadId, OTHER);
  });
});

describe('the whole set', () => {
  it('lists what it holds, so a resolver can work through it', () => {
    const grants = registry();
    grants.hold(grantFor());
    grants.hold(grantFor({ workloadId: OTHER }));
    assert.deepEqual(grants.all().map((g) => g.workloadId).sort(), [WORKLOAD, OTHER].sort());
  });
});
