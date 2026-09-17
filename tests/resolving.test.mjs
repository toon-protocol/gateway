// Resolution: which member of the Standby Set is running the workload, what a
// readable `name` is served at, and what a tenant is told when nothing is.
//
// Driven at the gateway's own listening port. A member is a stub connector
// answering `status` (spec §6.5); the answer is the whole of what resolution
// has to go on.

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { CONSTANTS, gatewayGrant, providerProfile } from './helpers/events.mjs';
import { startTestGateway } from './helpers/harness.mjs';
import { refusal, running, startStubConnector } from './helpers/stub-connector.mjs';
import { startStubRelay } from './helpers/stub-relay.mjs';
import { startStubWorkload } from './helpers/stub-workload.mjs';

const GATEWAY = CONSTANTS.gateway.public_key;
const MEMBER = CONSTANTS.provider;
const WORKLOAD = 'aa'.repeat(32);
const OTHER_WORKLOAD = 'bb'.repeat(32);
const HTTP_PORT = 8080;

/** A grant for a one-member Standby Set: everything else here is about the answer. */
const grantFor = (overrides = {}) =>
  gatewayGrant({
    workloadId: WORKLOAD,
    gateway: GATEWAY,
    httpPort: HTTP_PORT,
    standbySet: [MEMBER.public_key],
    ...overrides,
  });

/** The one member, its connector and its Profile. */
async function member(t, answer) {
  const connector = await startStubConnector({ pubkey: MEMBER.public_key, answer });
  t.after(() => connector.close());
  const profile = providerProfile({
    providerSecret: MEMBER.secret_key,
    connectorUrl: connector.url,
    relays: [],
  });
  return { connector, profile };
}

/** What a member running `workload` at `port` answers. */
const runningAt = (port, host = '127.0.0.1') => ({ workloadId }) =>
  running({ workloadId, host, ports: [{ container_port: HTTP_PORT, host_port: port }] });

describe('when no member is running the workload', () => {
  it('says so, once every member has answered something else', async (t) => {
    const { profile } = await member(t, ({ workloadId }) => ({
      workload_id: workloadId,
      role: 'standby',
      state: 'reserved',
      expires_at: CONSTANTS.now + 3600,
    }));

    const gateway = await startTestGateway({ events: [grantFor(), profile] });
    t.after(() => gateway.close());

    const answered = await gateway.get(gateway.hostFor(WORKLOAD));
    assert.equal(answered.status, 503);
    assert.equal(answered.headers['toon-gateway-reason'], 'no_running_member');
    assert.match(answered.json().message, new RegExp(WORKLOAD));
  });

  it('says so for a lease that ended, too', async (t) => {
    const { profile } = await member(t, ({ workloadId }) => ({
      workload_id: workloadId,
      role: 'standalone',
      state: { ended: 'expiry' },
      expires_at: CONSTANTS.now - 10,
    }));

    const gateway = await startTestGateway({ events: [grantFor(), profile] });
    t.after(() => gateway.close());

    assert.equal(
      (await gateway.get(gateway.hostFor(WORKLOAD))).headers['toon-gateway-reason'],
      'no_running_member',
    );
  });
});

describe('when a member tells this gateway nothing', () => {
  it('does not call a refusal an answer about the lease', async (t) => {
    // A grant this member will not read — expired at the provider, say. It
    // has NOT said the workload is stopped, and saying so to the tenant would
    // be telling it something about its lease that nobody established.
    const { profile } = await member(t, () =>
      refusal('bad_grant', 'that grant does not admit you here'),
    );

    const gateway = await startTestGateway({ events: [grantFor(), profile] });
    t.after(() => gateway.close());

    const answered = await gateway.get(gateway.hostFor(WORKLOAD));
    assert.equal(answered.headers['toon-gateway-reason'], 'member_unreachable');
    assert.match(answered.json().message, /bad_grant/);
  });

  it('cannot ask a member whose Provider Profile it has never seen', async (t) => {
    // The grant names a member; no Profile of that member is on any relay, so
    // there is nowhere to ask it anything.
    const gateway = await startTestGateway({
      events: [grantFor()],
      env: { GATEWAY_RESOLVE_TIMEOUT_MS: '250' },
    });
    t.after(() => gateway.close());

    const answered = await gateway.get(gateway.hostFor(WORKLOAD));
    assert.equal(answered.headers['toon-gateway-reason'], 'member_unreachable');
    assert.match(answered.json().message, /Profile/i);
  });
});

describe('when the member cannot be reached', () => {
  it('says the member is unreachable when its connector never answers', async (t) => {
    const { connector, profile } = await member(t, runningAt(1));
    connector.goSilent();

    const gateway = await startTestGateway({
      events: [grantFor(), profile],
      env: { GATEWAY_RESOLVE_TIMEOUT_MS: '250' },
    });
    t.after(() => gateway.close());

    const answered = await gateway.get(gateway.hostFor(WORKLOAD));
    assert.equal(answered.status, 503);
    assert.equal(answered.headers['toon-gateway-reason'], 'member_unreachable');
  });

  it('says the same when the running member\'s own address will not answer', async (t) => {
    // A port nobody is listening on: started, so it is certainly free, then
    // closed. The member says `running` and means it; the address is dead.
    const gone = await startStubWorkload({});
    const deadPort = gone.port;
    await gone.close();

    const { profile } = await member(t, runningAt(deadPort));

    const gateway = await startTestGateway({ events: [grantFor(), profile] });
    t.after(() => gateway.close());

    const answered = await gateway.get(gateway.hostFor(WORKLOAD));
    assert.equal(answered.status, 503);
    assert.equal(answered.headers['toon-gateway-reason'], 'member_unreachable');
    assert.match(answered.json().message, new RegExp(String(deadPort)));
  });
});

describe('a readable name', () => {
  it('serves the first grant to claim it, logs the second, and keeps both canonical', async (t) => {
    const first = await startStubWorkload({ body: 'the first workload' });
    const second = await startStubWorkload({ body: 'the second workload' });
    for (const stub of [first, second]) t.after(() => stub.close());

    const port = (workloadId) => (workloadId === WORKLOAD ? first.port : second.port);
    const { profile } = await member(t, ({ workloadId }) =>
      running({
        workloadId,
        host: '127.0.0.1',
        ports: [{ container_port: HTTP_PORT, host_port: port(workloadId) }],
      }),
    );

    const mine = grantFor({ name: 'shop' });
    const theirs = gatewayGrant({
      workloadId: OTHER_WORKLOAD,
      gateway: GATEWAY,
      httpPort: HTTP_PORT,
      standbySet: [MEMBER.public_key],
      name: 'shop',
      createdAt: CONSTANTS.now + 10,
    });

    // `mine` is on the relay first, so it is the grant that claimed the name.
    const gateway = await startTestGateway({ events: [mine, theirs, profile] });
    t.after(() => gateway.close());

    // The name belongs to the grant that claimed it first.
    const named = await gateway.get(`shop.${gateway.domain}`);
    assert.equal(named.status, 200);
    assert.equal(named.body, 'the first workload');

    // And BOTH workloads stay reachable at the name a tenant can always derive.
    assert.equal((await gateway.get(gateway.hostFor(WORKLOAD))).body, 'the first workload');
    assert.equal((await gateway.get(gateway.hostFor(OTHER_WORKLOAD))).body, 'the second workload');

    assert.ok(
      gateway.log.some((line) => line.includes('shop') && line.includes(OTHER_WORKLOAD)),
      `the conflict was logged; the log was:\n${gateway.log.join('\n')}`,
    );
  });

  it('passes to a later grant once the grant that claimed it is out of force', async (t) => {
    const first = await startStubWorkload({ body: 'the first workload' });
    const second = await startStubWorkload({ body: 'the second workload' });
    for (const stub of [first, second]) t.after(() => stub.close());

    const port = (workloadId) => (workloadId === WORKLOAD ? first.port : second.port);
    const { profile } = await member(t, ({ workloadId }) =>
      running({
        workloadId,
        host: '127.0.0.1',
        ports: [{ container_port: HTTP_PORT, host_port: port(workloadId) }],
      }),
    );

    let clock = CONSTANTS.now;
    const gateway = await startTestGateway({
      events: [grantFor({ name: 'shop', expiresAt: CONSTANTS.now + 100 }), profile],
      now: () => clock,
    });
    t.after(() => gateway.close());

    const named = `shop.${gateway.domain}`;
    assert.equal((await gateway.get(named)).body, 'the first workload');

    // The grant runs out. The readable name says exactly what the canonical
    // hostname says — the name did not quietly become somebody else's.
    clock = CONSTANTS.now + 200;
    assert.equal((await gateway.get(named)).headers['toon-gateway-reason'], 'grant_expired');

    // And now another tenant may have it: the claim it lost was its priority.
    gateway.publish(
      gatewayGrant({
        workloadId: OTHER_WORKLOAD,
        gateway: GATEWAY,
        httpPort: HTTP_PORT,
        standbySet: [MEMBER.public_key],
        name: 'shop',
        createdAt: CONSTANTS.now + 200,
      }),
    );

    await gateway.untilServed(named);
    assert.equal((await gateway.get(named)).body, 'the second workload');
  });

  it('is dropped when it is not a single DNS label, and the workload is served anyway', async (t) => {
    const workload = await startStubWorkload({ body: 'the application answered' });
    t.after(() => workload.close());
    const { profile } = await member(t, runningAt(workload.port));

    const gateway = await startTestGateway({
      events: [grantFor({ name: 'not a label' }), profile],
    });
    t.after(() => gateway.close());

    assert.equal((await gateway.get(gateway.hostFor(WORKLOAD))).status, 200);
  });
});

describe('a member\'s own Relay Set', () => {
  it('is read from its Profile and watched, so a Profile this gateway never had reaches it', async (t) => {
    const workload = await startStubWorkload({ body: 'the application answered' });
    t.after(() => workload.close());

    // The member moved its connector. The Profile that says where to is on
    // the member's OWN Relay Set, which this gateway is not configured with —
    // all it is configured with is a relay carrying the older Profile that
    // names those relays (spec §4, §12.4).
    const moved = await startStubConnector({
      pubkey: MEMBER.public_key,
      answer: runningAt(workload.port),
    });
    t.after(() => moved.close());

    const theirs = await startStubRelay({});
    t.after(() => theirs.close());
    theirs.publish(
      providerProfile({
        providerSecret: MEMBER.secret_key,
        connectorUrl: moved.url,
        relays: [theirs.url],
        createdAt: CONSTANTS.now + 10,
      }),
    );

    const stale = await startStubConnector({ pubkey: MEMBER.public_key });
    t.after(() => stale.close());
    const announcement = providerProfile({
      providerSecret: MEMBER.secret_key,
      connectorUrl: stale.url,
      relays: [theirs.url],
    });

    const gateway = await startTestGateway({ events: [grantFor(), announcement] });
    t.after(() => gateway.close());

    await gateway.untilServed(gateway.hostFor(WORKLOAD));
    assert.equal((await gateway.get(gateway.hostFor(WORKLOAD))).body, 'the application answered');
  });
});
