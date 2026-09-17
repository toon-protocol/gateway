// Following the workload: a Takeover, a self-stop, an expiring grant.
//
// Driven at the gateway's own listening port, with a MUTABLE CLOCK: the
// gateway is given `now: () => clock`, so a settle window and a Liveness
// cadence pass because a test moved time, not because a test slept. What is
// asserted is what a tenant would see at the URL, and what the members were
// asked — never what the gateway holds.
//
// `GATEWAY_FOLLOW_TICK_MS` is how often the gateway looks at the clock. It is
// 20 ms here so a test does not wait a second for it to notice; in production
// it is 1000 ms, and it does not change WHEN anything is due, only how soon
// after that it happens.

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { CONSTANTS, gatewayGrant, providerProfile, takeover } from './helpers/events.mjs';
import { startTestGateway, until } from './helpers/harness.mjs';
import { running, startStubConnector } from './helpers/stub-connector.mjs';
import { startStubRelay } from './helpers/stub-relay.mjs';
import { startStubWorkload } from './helpers/stub-workload.mjs';

const GATEWAY = CONSTANTS.gateway.public_key;
const PRIMARY = CONSTANTS.primary_provider;
const STANDBY = CONSTANTS.standby_provider;
const STRANGER = CONSTANTS.other_tenant;
const WORKLOAD = 'aa'.repeat(32);
const HTTP_PORT = 8080;

/** The Liveness cadence the primary's Profile states, and the window §7.1 gives the standbys. */
const CADENCE = 60;
const SETTLE = 2 * CADENCE;

/** The gateway looks at the clock this often; it decides nothing. */
const FOLLOWS_FAST = { GATEWAY_FOLLOW_TICK_MS: '20' };

const RESERVED = ({ workloadId }) => ({
  workload_id: workloadId,
  role: 'standby',
  state: 'reserved',
  expires_at: CONSTANTS.now + 3600,
});

/** A primary that stopped its own workload under §7.1's self-stop rule. */
const STOPPED = ({ workloadId }) => ({
  workload_id: workloadId,
  role: 'primary',
  state: 'stopped',
  expires_at: CONSTANTS.now + 3600,
});

const ENDED = ({ workloadId }) => ({
  workload_id: workloadId,
  role: 'standalone',
  state: { ended: 'expiry' },
  expires_at: CONSTANTS.now - 1,
});

/**
 * One Standby Set member: its connector, the workload behind it, its Profile,
 * and what it answers `status` with.
 *
 * @param {import('node:test').TestContext} t
 * @param {{ public_key: string, secret_key: string }} key
 * @param {{ body: string, relays?: string[], cadence?: number, state?: string }} options
 */
async function member(t, key, { body, relays = [], cadence = CADENCE, state = 'reserved' }) {
  const workload = await startStubWorkload({ body });
  t.after(() => workload.close());
  const connector = await startStubConnector({ pubkey: key.public_key });
  t.after(() => connector.close());

  const it = {
    connector,
    workload,
    profile: providerProfile({
      providerSecret: key.secret_key,
      connectorUrl: connector.url,
      relays,
      livenessCadenceS: cadence,
    }),
    /** How many `status` requests this member has been sent. */
    get asked() {
      return connector.requests.length;
    },
    runs: () =>
      connector.answerWith(({ workloadId }) =>
        running({
          workloadId,
          host: '127.0.0.1',
          ports: [{ container_port: HTTP_PORT, host_port: workload.port }],
        }),
      ),
    reserved: () => connector.answerWith(RESERVED),
    stopped: () => connector.answerWith(STOPPED),
    ended: () => connector.answerWith(ENDED),
    silent: (value = true) => connector.goSilent(value),
  };
  if (state === 'running') it.runs();
  else it.reserved();
  return it;
}

/** A grant for a two-member Standby Set, primary first. */
const grantFor = (overrides = {}) =>
  gatewayGrant({
    workloadId: WORKLOAD,
    gateway: GATEWAY,
    httpPort: HTTP_PORT,
    standbySet: [PRIMARY.public_key, STANDBY.public_key],
    ...overrides,
  });

/** Wait until the gateway has SAID something, so a clock jump cannot overtake it. */
const untilLogged = (gateway, pattern) =>
  until(() => gateway.log.some((line) => pattern.test(line)), {
    what: `the gateway to log ${pattern}`,
  });

describe('a Takeover', () => {
  it('moves forwarding to the member that now reports running, and not before the settle window', async (t) => {
    // The primary's OWN Relay Set: a separate relay, which this gateway is not
    // configured with. The Takeover is published only there (spec §7.1), so a
    // gateway that watched its own relays instead would never see it.
    const theirs = await startStubRelay({});
    t.after(() => theirs.close());

    const primary = await member(t, PRIMARY, {
      body: 'the primary\'s copy',
      relays: [theirs.url],
      state: 'running',
    });
    const standby = await member(t, STANDBY, { body: 'the standby\'s copy' });

    let clock = CONSTANTS.now;
    const gateway = await startTestGateway({
      events: [grantFor(), primary.profile, standby.profile],
      now: () => clock,
      env: FOLLOWS_FAST,
    });
    t.after(() => gateway.close());

    const host = gateway.hostFor(WORKLOAD);
    assert.equal((await gateway.get(host)).body, 'the primary\'s copy');

    // The primary went silent and stopped its own workload; the standby
    // announces the Takeover but has not started anything yet, exactly as
    // §7.1 has it for the two cadences after its own announcement.
    primary.stopped();
    const askedBefore = primary.asked + standby.asked;
    theirs.publish(takeover({ standbySecret: STANDBY.secret_key, workloadId: WORKLOAD }));
    await untilLogged(gateway, new RegExp(`settle window.*${WORKLOAD}|${WORKLOAD}.*settle window`));

    // Inside the window: nobody is asked, because there would be nothing
    // running to find, and the URL keeps answering from where it was.
    clock = CONSTANTS.now + SETTLE - 1;
    await new Promise((done) => setTimeout(done, 150));
    assert.equal(
      primary.asked + standby.asked,
      askedBefore,
      'no member was asked inside the settle window',
    );
    assert.equal((await gateway.get(host)).body, 'the primary\'s copy');

    // The window passes; by now the standby is running the workload.
    standby.runs();
    clock = CONSTANTS.now + SETTLE;
    await until(async () => (await gateway.get(host)).body === 'the standby\'s copy', {
      what: 'the URL to move to the standby',
    });
    assert.equal((await gateway.get(host)).status, 200);
  });

  it('counts the settle window in two cadences of the PRIMARY\'s Profile', async (t) => {
    const theirs = await startStubRelay({});
    t.after(() => theirs.close());

    // Ten seconds for the primary, a thousand for the standby: if the window
    // were counted in the standby's cadence, nothing would move here at all.
    const primary = await member(t, PRIMARY, {
      body: 'the primary\'s copy',
      relays: [theirs.url],
      cadence: 10,
      state: 'running',
    });
    const standby = await member(t, STANDBY, { body: 'the standby\'s copy', cadence: 1000 });

    let clock = CONSTANTS.now;
    const gateway = await startTestGateway({
      events: [grantFor(), primary.profile, standby.profile],
      now: () => clock,
      env: FOLLOWS_FAST,
    });
    t.after(() => gateway.close());

    const host = gateway.hostFor(WORKLOAD);
    assert.equal((await gateway.get(host)).body, 'the primary\'s copy');

    primary.stopped();
    standby.runs();
    theirs.publish(takeover({ standbySecret: STANDBY.secret_key, workloadId: WORKLOAD }));
    await untilLogged(gateway, /settle window/);

    // One second short of two of the PRIMARY's cadences.
    clock = CONSTANTS.now + 19;
    await new Promise((done) => setTimeout(done, 150));
    assert.equal(
      (await gateway.get(host)).body,
      'the primary\'s copy',
      'the previous target keeps serving until the window has passed',
    );

    clock = CONSTANTS.now + 20;
    await until(async () => (await gateway.get(host)).body === 'the standby\'s copy', {
      what: 'the URL to move after two of the primary\'s cadences',
    });
  });

  it('ignores a claim signed by a key the grant does not name', async (t) => {
    const theirs = await startStubRelay({});
    t.after(() => theirs.close());

    const primary = await member(t, PRIMARY, {
      body: 'the primary\'s copy',
      relays: [theirs.url],
      state: 'running',
    });
    const standby = await member(t, STANDBY, { body: 'the standby\'s copy' });

    let clock = CONSTANTS.now;
    const gateway = await startTestGateway({
      events: [grantFor(), primary.profile, standby.profile],
      now: () => clock,
      env: FOLLOWS_FAST,
    });
    t.after(() => gateway.close());

    const host = gateway.hostFor(WORKLOAD);
    assert.equal((await gateway.get(host)).body, 'the primary\'s copy');

    // Anybody may publish a kind 30433 with this `d`. Only a member of the
    // Standby Set may claim the workload (spec §7.1), so this one changes
    // nothing — and in particular does not hold up the per-cadence re-ask.
    theirs.publish(takeover({ standbySecret: STRANGER.secret_key, workloadId: WORKLOAD }));
    await untilLogged(gateway, /claim|Takeover/i);
    assert.ok(
      !gateway.log.some((line) => line.includes('settle window')),
      `no settle window was opened; the log was:\n${gateway.log.join('\n')}`,
    );
    assert.equal((await gateway.get(host)).body, 'the primary\'s copy');
  });
});

describe('the per-cadence re-ask', () => {
  it('drops a member that stopped the workload itself, within one cadence', async (t) => {
    const primary = await member(t, PRIMARY, { body: 'the primary\'s copy', state: 'running' });

    let clock = CONSTANTS.now;
    const gateway = await startTestGateway({
      events: [grantFor({ standbySet: [PRIMARY.public_key] }), primary.profile],
      now: () => clock,
      env: FOLLOWS_FAST,
    });
    t.after(() => gateway.close());

    const host = gateway.hostFor(WORKLOAD);
    assert.equal((await gateway.get(host)).status, 200);

    // Nothing is announced: a self-stop (§7.1) leaves no event anywhere. The
    // only thing that finds it is asking again.
    primary.stopped();
    const askedBefore = primary.asked;
    clock = CONSTANTS.now + CADENCE + 1;
    await until(() => primary.asked > askedBefore, { what: 'the per-cadence re-ask' });

    const answered = await gateway.get(host);
    assert.equal(answered.status, 503);
    assert.equal(answered.headers['toon-gateway-reason'], 'no_running_member');
  });

  it('re-resolves to another member that is running it, with no Takeover seen', async (t) => {
    const primary = await member(t, PRIMARY, { body: 'the primary\'s copy', state: 'running' });
    const standby = await member(t, STANDBY, { body: 'the standby\'s copy' });

    let clock = CONSTANTS.now;
    const gateway = await startTestGateway({
      events: [grantFor(), primary.profile, standby.profile],
      now: () => clock,
      env: FOLLOWS_FAST,
    });
    t.after(() => gateway.close());

    const host = gateway.hostFor(WORKLOAD);
    assert.equal((await gateway.get(host)).body, 'the primary\'s copy');

    // The workload moved and this gateway never saw the claim — a relay it
    // could not read, say. A cadence later it asks anyway, and finds it.
    primary.ended();
    standby.runs();
    clock = CONSTANTS.now + CADENCE + 1;
    await until(async () => (await gateway.get(host)).body === 'the standby\'s copy', {
      what: 'the workload to be found on the standby',
    });
  });

  it('answers 503 within a cadence when the member that was running says nothing', async (t) => {
    const primary = await member(t, PRIMARY, { body: 'the primary\'s copy', state: 'running' });

    let clock = CONSTANTS.now;
    const gateway = await startTestGateway({
      events: [grantFor({ standbySet: [PRIMARY.public_key] }), primary.profile],
      now: () => clock,
      env: { ...FOLLOWS_FAST, GATEWAY_RESOLVE_TIMEOUT_MS: '250' },
    });
    t.after(() => gateway.close());

    const host = gateway.hostFor(WORKLOAD);
    assert.equal((await gateway.get(host)).status, 200);

    // The whole member is gone: its connector accepts the connection and
    // never answers, and the workload's own port is gone with it.
    primary.silent();
    await primary.workload.close();
    clock = CONSTANTS.now + CADENCE + 1;
    await gateway.untilReason(host, 'member_unreachable');
  });
});

describe('the last known target', () => {
  it('keeps serving while a re-resolution is in flight against a silent member', async (t) => {
    const primary = await member(t, PRIMARY, { body: 'the primary\'s copy', state: 'running' });

    let clock = CONSTANTS.now;
    const gateway = await startTestGateway({
      events: [grantFor({ standbySet: [PRIMARY.public_key] }), primary.profile],
      now: () => clock,
      env: { ...FOLLOWS_FAST, GATEWAY_RESOLVE_TIMEOUT_MS: '2000' },
    });
    t.after(() => gateway.close());

    const host = gateway.hostFor(WORKLOAD);
    assert.equal((await gateway.get(host)).status, 200);

    // The member's connector stops answering, but the WORKLOAD is still up.
    // A gateway that waited for the re-resolution, or that dropped the target
    // when it started one, would take a running workload offline.
    primary.silent();
    const askedBefore = primary.asked;
    clock = CONSTANTS.now + CADENCE + 1;
    await until(() => primary.asked > askedBefore, { what: 'the re-ask to be in flight' });

    for (let i = 0; i < 3; i += 1) {
      const started = Date.now();
      const answered = await gateway.get(host, { path: `/while-in-flight/${i}` });
      assert.equal(answered.status, 200, 'a running workload is not taken offline by a slow member');
      assert.equal(answered.body, 'the primary\'s copy');
      assert.ok(
        Date.now() - started < 500,
        'it answered from the last known target rather than waiting for the re-resolution',
      );
    }

    // And the connector coming back changes nothing about what was served.
    primary.silent(false);
    assert.equal((await gateway.get(host)).status, 200);
  });

  it('keeps serving while a re-resolution waits for a Profile off a relay', async (t) => {
    const theirs = await startStubRelay({});
    t.after(() => theirs.close());

    const primary = await member(t, PRIMARY, {
      body: 'the primary\'s copy',
      relays: [theirs.url],
      state: 'running',
    });
    const standby = await member(t, STANDBY, { body: 'the standby\'s copy' });

    let clock = CONSTANTS.now;
    // The standby's Profile is on NO relay: the re-resolution the Takeover
    // triggers will wait for it until the resolve timeout.
    const gateway = await startTestGateway({
      events: [grantFor(), primary.profile],
      now: () => clock,
      env: { ...FOLLOWS_FAST, GATEWAY_RESOLVE_TIMEOUT_MS: '1500' },
    });
    t.after(() => gateway.close());

    const host = gateway.hostFor(WORKLOAD);
    assert.equal((await gateway.get(host)).body, 'the primary\'s copy');

    theirs.publish(takeover({ standbySecret: STANDBY.secret_key, workloadId: WORKLOAD }));
    await untilLogged(gateway, /settle window/);
    clock = CONSTANTS.now + SETTLE;
    await until(() => standby.asked > 0 || primary.asked > 1, {
      what: 'the re-resolution to start',
    });

    for (let i = 0; i < 3; i += 1) {
      const started = Date.now();
      const answered = await gateway.get(host, { path: `/slow-relay/${i}` });
      assert.equal(answered.status, 200, 'a slow relay does not take a healthy workload offline');
      assert.equal(answered.body, 'the primary\'s copy');
      assert.ok(
        Date.now() - started < 500,
        'it answered from the last known target rather than waiting for the relay',
      );
    }
  });
});

describe('a grant that runs out', () => {
  it('stops being served, and nothing more is asked of a provider on its account', async (t) => {
    const primary = await member(t, PRIMARY, { body: 'the primary\'s copy', state: 'running' });

    let clock = CONSTANTS.now;
    const gateway = await startTestGateway({
      events: [
        grantFor({ standbySet: [PRIMARY.public_key], expiresAt: CONSTANTS.now + 100 }),
        primary.profile,
      ],
      now: () => clock,
      env: FOLLOWS_FAST,
    });
    t.after(() => gateway.close());

    const host = gateway.hostFor(WORKLOAD);
    assert.equal((await gateway.get(host)).status, 200);

    // Nobody restarts anything and no operator does anything: the grant
    // simply runs out.
    clock = CONSTANTS.now + 101;
    await gateway.untilReason(host, 'grant_expired');

    const askedBefore = primary.asked;
    await new Promise((done) => setTimeout(done, 150));
    assert.equal(
      primary.asked,
      askedBefore,
      'an expired grant is not carried to a provider, which would refuse it',
    );
  });

  it('starts again when its tenant republishes it, with no restart', async (t) => {
    const primary = await member(t, PRIMARY, { body: 'the primary\'s copy', state: 'running' });

    let clock = CONSTANTS.now;
    const gateway = await startTestGateway({
      events: [
        grantFor({ standbySet: [PRIMARY.public_key], expiresAt: CONSTANTS.now + 100 }),
        primary.profile,
      ],
      now: () => clock,
      env: FOLLOWS_FAST,
    });
    t.after(() => gateway.close());

    const host = gateway.hostFor(WORKLOAD);
    clock = CONSTANTS.now + 101;
    await gateway.untilReason(host, 'grant_expired');

    gateway.publish(
      grantFor({
        standbySet: [PRIMARY.public_key],
        createdAt: CONSTANTS.now + 101,
        expiresAt: CONSTANTS.now + 3600,
      }),
    );
    await gateway.untilServed(host);
    assert.equal((await gateway.get(host)).body, 'the primary\'s copy');
  });
});

describe('a grant that names another gateway', () => {
  it('withdraws the workload, though the rotation names that other gateway in its `p` tag', async (t) => {
    const primary = await member(t, PRIMARY, { body: 'the primary\'s copy', state: 'running' });

    const gateway = await startTestGateway({
      events: [grantFor({ standbySet: [PRIMARY.public_key] }), primary.profile],
      env: FOLLOWS_FAST,
    });
    t.after(() => gateway.close());

    const host = gateway.hostFor(WORKLOAD);
    assert.equal((await gateway.get(host)).status, 200);

    // The tenant rotated to another gateway. That grant's `p` tag names the
    // OTHER gateway, so §12.1's filter cannot carry it; the watch on the
    // workload id is what delivers it.
    gateway.publish(
      grantFor({
        standbySet: [PRIMARY.public_key],
        gateway: 'cc'.repeat(32),
        createdAt: CONSTANTS.now + 10,
      }),
    );

    await gateway.untilReason(host, 'no_grant');
    const askedBefore = primary.asked;
    await new Promise((done) => setTimeout(done, 100));
    assert.equal(primary.asked, askedBefore, 'and it is not followed any more either');
  });

  it('does not let a grant signed by somebody else take a workload away', async (t) => {
    const primary = await member(t, PRIMARY, { body: 'the primary\'s copy', state: 'running' });

    const gateway = await startTestGateway({
      events: [grantFor({ standbySet: [PRIMARY.public_key] }), primary.profile],
      env: FOLLOWS_FAST,
    });
    t.after(() => gateway.close());

    const host = gateway.hostFor(WORKLOAD);
    assert.equal((await gateway.get(host)).status, 200);

    // A stranger's grant for somebody else's workload id, naming another
    // gateway and dated later. Only the tenant of the grant held may replace
    // it, or anyone at all could take any workload off any gateway.
    gateway.publish(
      grantFor({
        tenantSecret: STRANGER.secret_key,
        standbySet: [PRIMARY.public_key],
        gateway: 'cc'.repeat(32),
        createdAt: CONSTANTS.now + 10,
      }),
    );

    await new Promise((done) => setTimeout(done, 150));
    assert.equal((await gateway.get(host)).status, 200, 'the tenant\'s own grant still stands');
    assert.ok(
      gateway.log.some((line) => /tenant/i.test(line)),
      `it said why it ignored the stranger's grant; the log was:\n${gateway.log.join('\n')}`,
    );
  });
});
