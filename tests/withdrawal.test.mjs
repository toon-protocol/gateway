// A Gateway Withdrawal: a tenant taking a workload off this gateway before
// the grant it handed over runs out (spec §12.7).
//
// Driven at the two seams a tenant has — a withdrawal POSTed at the gateway's
// own tenant door, a request at the hostname — against a member that checks a
// presented grant the way a provider checks one (`asProvider`), so that what
// is withdrawn here really was admitted here.
//
// These tests are about PROOF rather than about agreement: the grant a
// withdrawal bears is derived from the lease's root secret, and a withdrawal
// bearing anything else is one a stranger could have sealed.

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { CONSTANTS, providerProfile } from './helpers/events.mjs';
import { asProvider, gatewayHandover, gatewayWithdrawal, grantFrom } from './helpers/handover.mjs';
import { admitAll, startTestGateway, until } from './helpers/harness.mjs';
import { running, startStubConnector } from './helpers/stub-connector.mjs';
import { startStubWorkload } from './helpers/stub-workload.mjs';

const MEMBER = CONSTANTS.provider;
const WORKLOAD = 'aa'.repeat(32);
const OTHER_WORKLOAD = 'bb'.repeat(32);
const HTTP_PORT = 8080;

const handoverFor = (overrides = {}) =>
  gatewayHandover({
    workloadId: WORKLOAD,
    httpPort: HTTP_PORT,
    standbySet: [MEMBER.public_key],
    ...overrides,
  });

const withdrawalFor = (overrides = {}) =>
  gatewayWithdrawal({ workloadId: WORKLOAD, standbySet: [MEMBER.public_key], ...overrides });

/**
 * A member that really holds the lease, and the workload behind it.
 *
 * It answers `running` for whichever workload is asked about, at that
 * workload's own stub — so a request that arrives says which workload the
 * hostname it was sent to names.
 *
 * @param {import('node:test').TestContext} t
 * @param {{ workloads?: string[], now?: () => number }} [options]
 */
async function member(t, { workloads = [WORKLOAD], now } = {}) {
  /** @type {Map<string, { port: number, body: string }>} */
  const behind = new Map();
  for (const workloadId of workloads) {
    const stub = await startStubWorkload({ body: `the workload ${workloadId.slice(0, 2)}` });
    t.after(() => stub.close());
    behind.set(workloadId, { port: stub.port, body: `the workload ${workloadId.slice(0, 2)}` });
  }

  // One `asProvider` per workload, because a provider checks a grant against
  // the lease it is about: a member holding two leases refuses a grant derived
  // for the other one, exactly as it refuses a stranger's.
  const answers = new Map(
    workloads.map((workloadId) => [
      workloadId,
      asProvider({
        member: MEMBER.public_key,
        workloadId,
        now,
        answer: () =>
          running({
            workloadId,
            host: '127.0.0.1',
            ports: [{ container_port: HTTP_PORT, host_port: behind.get(workloadId).port }],
          }),
      }),
    ]),
  );
  const connector = await startStubConnector({
    pubkey: MEMBER.public_key,
    answer: (context) => (answers.get(context.workloadId) ?? answers.get(workloads[0]))(context),
  });
  t.after(() => connector.close());

  return {
    connector,
    profile: providerProfile({
      providerSecret: MEMBER.secret_key,
      connectorUrl: connector.url,
      relays: [],
    }),
    /** What the workload behind this member answers, for telling two apart. */
    bodyOf: (workloadId) => behind.get(workloadId)?.body,
    /** How many `status` requests this member has been sent. */
    get asked() {
      return connector.requests.length;
    },
  };
}

describe('a withdrawal bearing the workload\'s current grant', () => {
  it('stops the workload being served at once, at both its names', async (t) => {
    const { profile } = await member(t);
    const gateway = await startTestGateway({
      events: [profile],
      handovers: [handoverFor({ name: 'shop' })],
    });
    t.after(() => gateway.close());

    const host = gateway.hostFor(WORKLOAD);
    const readable = `shop.${gateway.domain}`;
    assert.equal((await gateway.get(host)).status, 200);
    assert.equal((await gateway.get(readable)).status, 200);

    const answered = await gateway.withdraw(withdrawalFor());
    assert.equal(answered.status, 200);
    assert.equal(answered.json().workload_id, WORKLOAD);
    assert.equal(answered.json().hostname, host);
    assert.equal(answered.json().withdrawn, true);

    // At once: the next request is answered by this gateway itself, at the
    // canonical hostname and at the readable name, with the reason a hostname
    // it holds nothing for is answered.
    assert.equal((await gateway.get(host)).headers['toon-gateway-reason'], 'no_grant');
    assert.equal((await gateway.get(readable)).headers['toon-gateway-reason'], 'no_grant');
  });

  it('gives the readable name up at once, for another workload to claim', async (t) => {
    const stub = await member(t, { workloads: [WORKLOAD, OTHER_WORKLOAD] });
    const gateway = await startTestGateway({
      events: [stub.profile],
      handovers: [handoverFor({ name: 'shop' })],
      probe: admitAll,
    });
    t.after(() => gateway.close());

    // First come, first served (§12.6): while the first workload is served
    // here, a second one asking for `shop` keeps only its canonical hostname.
    const theirs = gatewayHandover({
      workloadId: OTHER_WORKLOAD,
      httpPort: HTTP_PORT,
      standbySet: [MEMBER.public_key],
      name: 'shop',
    });
    await gateway.handover(theirs);
    const readable = `shop.${gateway.domain}`;
    assert.equal((await gateway.get(readable)).body, stub.bodyOf(WORKLOAD));

    await gateway.withdraw(withdrawalFor());
    await gateway.handover(theirs);
    await until(async () => (await gateway.get(readable)).body === stub.bodyOf(OTHER_WORKLOAD), {
      what: 'the withdrawn workload\'s name to pass to the workload that asked next',
    });
  });

  it('stops following the workload: nothing more is asked of a provider on its account', async (t) => {
    const stub = await member(t);
    let clock = CONSTANTS.now;
    const gateway = await startTestGateway({
      events: [stub.profile],
      handovers: [handoverFor()],
      now: () => clock,
      env: { GATEWAY_FOLLOW_TICK_MS: '20' },
    });
    t.after(() => gateway.close());

    assert.equal((await gateway.get(gateway.hostFor(WORKLOAD))).status, 200);
    await until(() => gateway.relay.openSubscriptions > 0, { what: 'the Takeover watch to open' });
    await gateway.withdraw(withdrawalFor());

    // It reads no relay on the workload's account either: the Takeover watch
    // §12.7 opens for a workload it holds is closed with the rest of following.
    await until(() => gateway.relay.openSubscriptions === 0, {
      what: 'the Takeover watch to close',
    });

    // A Liveness cadence passes. A gateway still following the workload would
    // ask its Standby Set again here; a withdrawn one has nothing to ask about.
    const askedBefore = stub.asked;
    clock = CONSTANTS.now + 3600;
    await new Promise((done) => setTimeout(done, 150));
    assert.equal(stub.asked, askedBefore, 'a withdrawn workload is not followed');
  });

  it('is not refused because the moment its grant names has passed', async (t) => {
    // `expires_at` says WHICH grant the withdrawal bears; it is not compared
    // with the clock (spec §12.7). An expired grant is still holding the
    // workload's names here, so withdrawing it is worth something.
    const stub = await member(t);
    let clock = CONSTANTS.now;
    const gateway = await startTestGateway({
      events: [stub.profile],
      handovers: [handoverFor({ name: 'shop', expiresAt: CONSTANTS.now + 100 })],
      now: () => clock,
    });
    t.after(() => gateway.close());

    const host = gateway.hostFor(WORKLOAD);
    clock = CONSTANTS.now + 101;
    assert.equal((await gateway.get(host)).headers['toon-gateway-reason'], 'grant_expired');

    const answered = await gateway.withdraw(withdrawalFor({ expiresAt: CONSTANTS.now + 100 }));
    assert.equal(answered.status, 200);
    assert.equal((await gateway.get(host)).headers['toon-gateway-reason'], 'no_grant');
    assert.equal((await gateway.get(`shop.${gateway.domain}`)).headers['toon-gateway-reason'], 'no_grant');
  });
});

describe('a withdrawal bearing anything else', () => {
  it('is ignored and logged, and the workload goes on being served', async (t) => {
    const stub = await member(t);
    const gateway = await startTestGateway({
      events: [stub.profile],
      handovers: [handoverFor()],
    });
    t.after(() => gateway.close());

    const host = gateway.hostFor(WORKLOAD);
    // Thirty-two bytes a stranger made up: the right shape, and not the value
    // this lease's Continuation Token derives.
    const answered = await gateway.withdraw(withdrawalFor({ grantFor: () => 'cd'.repeat(32) }));
    assert.equal(answered.status, 403);
    assert.equal(answered.json().error, 'not_withdrawn');

    assert.equal((await gateway.get(host)).status, 200, 'a stranger takes nothing off this gateway');
    assert.ok(
      gateway.log.some((line) => line.includes('ignored') && line.includes(WORKLOAD)),
      `the withdrawal was logged; the log was:\n${gateway.log.join('\n')}`,
    );
  });

  it('is ignored when it bears the grant this gateway held BEFORE a renewal', async (t) => {
    const stub = await member(t);
    const gateway = await startTestGateway({
      events: [stub.profile],
      handovers: [handoverFor({ expiresAt: CONSTANTS.now + 100 })],
    });
    t.after(() => gateway.close());

    // The tenant renewed: a second handover, derived for a later moment, is
    // what this gateway reads the lease with now.
    await gateway.handover(handoverFor({ expiresAt: CONSTANTS.now + 9000 }));

    const stale = await gateway.withdraw(withdrawalFor({ expiresAt: CONSTANTS.now + 100 }));
    assert.equal(stale.json().error, 'not_withdrawn');
    assert.equal((await gateway.get(gateway.hostFor(WORKLOAD))).status, 200);

    // And the grant in force takes the workload off, so nothing about this
    // gateway has stopped working.
    const current = await gateway.withdraw(withdrawalFor({ expiresAt: CONSTANTS.now + 9000 }));
    assert.equal(current.status, 200);
  });

  it('is refused when it is not a withdrawal at all, and nothing is withdrawn', async (t) => {
    const stub = await member(t);
    const gateway = await startTestGateway({
      events: [stub.profile],
      handovers: [handoverFor()],
    });
    t.after(() => gateway.close());

    const good = withdrawalFor().withdrawal;
    const bad = [
      { withdrawal: { ...good, workload_id: 'nope' } },
      { withdrawal: { ...good, expires_at: 'soon' } },
      { withdrawal: { ...good, standby_set: [] } },
      // A handover's fields are not a withdrawal's: refused, never dropped.
      { withdrawal: { ...good, http_port: HTTP_PORT } },
      { withdrawal: { ...good, name: 'shop' } },
      { withdrawal: { ...good, standby_set: [{ provider: MEMBER.public_key }] } },
    ];
    for (const body of bad) {
      const answered = await gateway.withdraw(body);
      assert.equal(answered.json().error, 'invalid_withdrawal', JSON.stringify(body));
      assert.equal(answered.status, 400);
    }
    assert.equal((await gateway.get(gateway.hostFor(WORKLOAD))).status, 200);
  });
});

describe('a withdrawal for a workload this gateway does not hold', () => {
  it('changes nothing and reaches no provider', async (t) => {
    const stub = await member(t);
    const gateway = await startTestGateway({
      events: [stub.profile],
      handovers: [handoverFor()],
    });
    t.after(() => gateway.close());

    const askedBefore = stub.asked;
    const answered = await gateway.withdraw(
      gatewayWithdrawal({ workloadId: OTHER_WORKLOAD, standbySet: [MEMBER.public_key] }),
    );
    assert.equal(answered.json().error, 'not_withdrawn');
    assert.equal(stub.asked, askedBefore, 'nobody was asked about a workload nobody handed over');
    assert.equal(
      (await gateway.get(gateway.hostFor(OTHER_WORKLOAD))).headers['toon-gateway-reason'],
      'no_grant',
    );
    assert.equal((await gateway.get(gateway.hostFor(WORKLOAD))).status, 200, 'and nothing else moved');
  });
});

describe('the grant a withdrawal bears', () => {
  it('appears in nothing this gateway answers or logs', async (t) => {
    const stub = await member(t);
    const expiresAt = CONSTANTS.now + 600;
    const gateway = await startTestGateway({
      events: [stub.profile],
      handovers: [handoverFor({ expiresAt })],
    });
    t.after(() => gateway.close());

    const secret = grantFrom(CONSTANTS.tenant.root_secret, MEMBER.public_key, expiresAt);
    const ignored = await gateway.withdraw(
      gatewayWithdrawal({ workloadId: OTHER_WORKLOAD, standbySet: [MEMBER.public_key], expiresAt }),
    );
    const withdrawn = await gateway.withdraw(withdrawalFor({ expiresAt }));

    for (const answered of [ignored, withdrawn]) {
      assert.doesNotMatch(answered.body, new RegExp(secret, 'i'));
    }
    assert.doesNotMatch(gateway.log.join('\n'), new RegExp(secret, 'i'));
  });
});
