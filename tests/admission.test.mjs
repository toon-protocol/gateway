// Admission: how a gateway decides to serve a workload it was sent (spec
// §12.1).
//
// Driven at the two seams a tenant has — a handover POSTed at the handover
// port, a request at the hostname — with a stub member that checks a presented
// grant the way a provider checks one (`asProvider`). That is what makes these
// tests about PROOF rather than about agreement: the member takes only the
// value the lease's own token derives, so a handover a stranger could have
// sealed is refused exactly where a real provider would refuse it.

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { K_PROFILE, K_TAKEOVER } from '../src/kinds.mjs';
import { CONSTANTS, providerProfile } from './helpers/events.mjs';
import { asProvider, gatewayHandover, grantFrom } from './helpers/handover.mjs';
import { startTestGateway, until } from './helpers/harness.mjs';
import { running, startStubConnector } from './helpers/stub-connector.mjs';

const MEMBER = CONSTANTS.provider;
const WORKLOAD = 'aa'.repeat(32);
const OTHER_WORKLOAD = 'bb'.repeat(32);
const HTTP_PORT = 8080;

const handoverFor = (overrides = {}) =>
  gatewayHandover({ workloadId: WORKLOAD, httpPort: HTTP_PORT, standbySet: [MEMBER.public_key], ...overrides });

/** A member that really holds the lease, and its Profile. */
async function member(t, { workloadId = WORKLOAD, host = '127.0.0.1', port = 41000 } = {}) {
  const connector = await startStubConnector({
    pubkey: MEMBER.public_key,
    answer: asProvider({
      member: MEMBER.public_key,
      workloadId,
      answer: (context) =>
        running({
          workloadId: context.workloadId,
          host,
          ports: [{ container_port: HTTP_PORT, host_port: port }],
        }),
    }),
  });
  t.after(() => connector.close());
  const profile = providerProfile({
    providerSecret: MEMBER.secret_key,
    connectorUrl: connector.url,
    relays: [],
  });
  return { connector, profile };
}

describe('a sealed handover', () => {
  it('puts a workload on its canonical hostname once one round accepts it', async (t) => {
    const { connector, profile } = await member(t);
    const gateway = await startTestGateway({ events: [profile] });
    t.after(() => gateway.close());

    const host = gateway.hostFor(WORKLOAD);
    assert.equal((await gateway.get(host)).headers['toon-gateway-reason'], 'no_grant');

    const answered = await gateway.handover(handoverFor());
    assert.equal(answered.status, 200);
    assert.equal(answered.json().workload_id, WORKLOAD);
    assert.equal(answered.json().hostname, host);

    assert.equal(connector.requests.length, 1, 'ONE round, and one member in the set');
    assert.notEqual((await gateway.get(host)).headers['toon-gateway-reason'], 'no_grant');
  });

  it('asks with the Lease Request of §6.1, presenting the grant as its `continuation`', async (t) => {
    const { connector, profile } = await member(t);
    const gateway = await startTestGateway({ events: [profile] });
    t.after(() => gateway.close());

    const expiresAt = CONSTANTS.now + 600;
    await gateway.handover(handoverFor({ expiresAt }));

    const [asked] = connector.requests;
    assert.equal(asked.path, '/status');
    assert.deepEqual(Object.keys(asked.body), ['request'], 'the packet body of §6.1.2');
    assert.equal(asked.request.op, 'status');
    assert.equal(asked.request.provider, MEMBER.public_key, 'exactly one provider is named');
    assert.equal(asked.request.expiration, CONSTANTS.now + 60);
    assert.match(asked.request.request_id, /^[0-9a-f]{64}$/);
    assert.equal(asked.request.sig, undefined, 'nobody signs a Lease Request');
    assert.equal(asked.request.pubkey, undefined, 'and it names no key at all');
    assert.equal(
      asked.continuation,
      grantFrom(CONSTANTS.tenant.root_secret, MEMBER.public_key, expiresAt),
      'the grant rides where the lease\'s own token would',
    );
    assert.equal(asked.gatewayExpiresAt, expiresAt, 'naming the moment it was derived for');
    assert.deepEqual(asked.content, { workload_id: WORKLOAD, gateway_expires_at: expiresAt });
  });

  it('reads no relay on the workload\'s account but for Profiles and Takeovers', async (t) => {
    const { profile } = await member(t);
    const gateway = await startTestGateway({ events: [profile] });
    t.after(() => gateway.close());

    await gateway.handover(handoverFor());
    await until(
      () => gateway.relay.requests.some((r) => r.filters.some((f) => f.kinds?.includes(K_TAKEOVER))),
      { what: 'the Takeover watch to open' },
    );

    const kinds = gateway.relay.requests.flatMap((r) => r.filters.flatMap((f) => f.kinds ?? []));
    assert.deepEqual([...new Set(kinds)].sort(), [K_PROFILE, K_TAKEOVER].sort());
  });

  it('replaces the grant it holds when a later handover is admitted for the workload', async (t) => {
    const { profile } = await member(t);
    const gateway = await startTestGateway({ events: [profile] });
    t.after(() => gateway.close());

    await gateway.handover(handoverFor({ expiresAt: CONSTANTS.now + 600 }));
    const renewed = await gateway.handover(handoverFor({ expiresAt: CONSTANTS.now + 9000 }));
    assert.equal(renewed.status, 200);
    assert.equal(renewed.json().expires_at, CONSTANTS.now + 9000);
    assert.equal(gateway.gateway.grants.size, 1, 'a renewal is not a second grant');
  });
});

describe('a handover the members refuse', () => {
  it('never puts the workload on a hostname, and is dropped rather than retried', async (t) => {
    const { connector, profile } = await member(t);
    const gateway = await startTestGateway({ events: [profile] });
    t.after(() => gateway.close());

    // Thirty-two bytes a stranger made up: it is the right shape and it is not
    // the value this lease's token derives, so the member will not take it.
    const answered = await gateway.handover(
      handoverFor({ grantFor: () => 'cd'.repeat(32) }),
    );
    assert.equal(answered.status, 403);
    assert.equal(answered.json().error, 'not_admitted');

    const host = gateway.hostFor(WORKLOAD);
    assert.equal((await gateway.get(host)).headers['toon-gateway-reason'], 'no_grant');
    assert.ok(
      gateway.log.some((line) => line.includes('took the grant') || line.includes('dropped')),
      `the refusal was logged; the log was:\n${gateway.log.join('\n')}`,
    );

    // Nothing retries it: one round was asked for, and asking the hostname
    // again asks nobody, because there is no grant to ask with.
    const asked = connector.requests.length;
    assert.equal(asked, 1);
    await gateway.get(host);
    await gateway.get(host);
    assert.equal(connector.requests.length, asked, 'the handover is gone, not queued');
  });

  it('is refused the same way when no member can be reached at all', async (t) => {
    const { connector, profile } = await member(t);
    connector.goSilent();
    const gateway = await startTestGateway({
      events: [profile],
      env: { GATEWAY_RESOLVE_TIMEOUT_MS: '250' },
    });
    t.after(() => gateway.close());

    const answered = await gateway.handover(handoverFor());
    assert.equal(answered.json().error, 'not_admitted');
    assert.equal((await gateway.get(gateway.hostFor(WORKLOAD))).headers['toon-gateway-reason'], 'no_grant');
  });
});

describe('what admission refuses before it asks anybody', () => {
  it('never carries an expired grant to a provider', async (t) => {
    const { connector, profile } = await member(t);
    const gateway = await startTestGateway({ events: [profile] });
    t.after(() => gateway.close());

    const answered = await gateway.handover(handoverFor({ expiresAt: CONSTANTS.now - 1 }));
    assert.equal(answered.json().error, 'grant_expired');
    assert.equal(connector.requests.length, 0, 'nothing was asked');
  });

  it('refuses something that is not a handover, and asks nobody', async (t) => {
    const { connector, profile } = await member(t);
    const gateway = await startTestGateway({ events: [profile] });
    t.after(() => gateway.close());

    const bad = [
      { handover: { ...handoverFor().handover, workload_id: 'nope' } },
      { handover: { ...handoverFor().handover, http_port: 0 } },
      { handover: { ...handoverFor().handover, standby_set: [] } },
      { handover: { ...handoverFor().handover, expires_at: 'soon' } },
      { handover: { ...handoverFor().handover, gateway: 'ff'.repeat(32) } },
      { grant: handoverFor().handover },
      handoverFor().handover,
      null,
    ];
    for (const body of bad) {
      const answered = await gateway.handover(body);
      assert.equal(answered.json().error, 'invalid_handover', JSON.stringify(body));
    }
    assert.equal(connector.requests.length, 0, 'nothing was asked');
  });

  it('refuses a member that carries no grant of its own', async (t) => {
    // Every member needs the grant derived for ITS key (spec §6.5.1), so a
    // handover carrying one value for a set of three admits nobody.
    const { connector, profile } = await member(t);
    const gateway = await startTestGateway({ events: [profile] });
    t.after(() => gateway.close());

    const answered = await gateway.handover(
      gatewayHandover({
        workloadId: WORKLOAD,
        members: [{ provider: MEMBER.public_key }],
      }),
    );
    assert.equal(answered.json().error, 'invalid_handover');
    assert.match(answered.json().message, /grant/);
    assert.equal(connector.requests.length, 0);
  });

  it('answers anything but a POSTed handover without asking anybody', async (t) => {
    const { connector, profile } = await member(t);
    const gateway = await startTestGateway({ events: [profile] });
    t.after(() => gateway.close());

    assert.equal((await gateway.handover(handoverFor(), { method: 'GET' })).status, 404);
    assert.equal((await gateway.handover(handoverFor(), { path: '/' })).status, 404);
    assert.equal(connector.requests.length, 0);
  });
});

describe('the amplification a sealed handover buys', () => {
  it('bounds how often one provider can be made to admit a handover', async (t) => {
    const { connector, profile } = await member(t);
    const gateway = await startTestGateway({
      events: [profile],
      env: { GATEWAY_ADMIT_PER_MINUTE: '2' },
    });
    t.after(() => gateway.close());

    // A stranger's handovers: the right shape, a grant nobody derived.
    const stranger = () => handoverFor({ grantFor: () => 'cd'.repeat(32) });
    const answers = [];
    for (let i = 0; i < 5; i += 1) answers.push(await gateway.handover(stranger()));

    assert.equal(connector.requests.length, 2, 'two rounds, not five');
    assert.equal(answers.filter((a) => a.json().error === 'rate_limited').length, 3);
    assert.equal(answers.at(-1).status, 429);
  });

  it('cannot be spread across workloads to exceed one provider\'s rate', async (t) => {
    const { connector, profile } = await member(t);
    const gateway = await startTestGateway({
      events: [profile],
      env: { GATEWAY_ADMIT_PER_MINUTE: '2' },
    });
    t.after(() => gateway.close());

    for (const workloadId of [WORKLOAD, OTHER_WORKLOAD, 'cc'.repeat(32), 'dd'.repeat(32)]) {
      await gateway.handover(
        gatewayHandover({ workloadId, standbySet: [MEMBER.public_key], grantFor: () => 'cd'.repeat(32) }),
      );
    }
    assert.equal(connector.requests.length, 2, 'the bucket is the member\'s, not the workload\'s');
  });

  it('bounds how many members one handover can name', async (t) => {
    const { connector, profile } = await member(t);
    const gateway = await startTestGateway({ events: [profile] });
    t.after(() => gateway.close());

    const many = Array.from({ length: 64 }, (_, i) => i.toString(16).padStart(2, '0').repeat(32));
    const answered = await gateway.handover(handoverFor({ standbySet: many }));
    assert.equal(answered.json().error, 'invalid_handover');
    assert.match(answered.json().message, /standby_set/);
    assert.equal(connector.requests.length, 0);
  });
});

describe('the grant a handover carries', () => {
  it('goes to the members and nowhere else: not a log line, not an answer', async (t) => {
    const { profile } = await member(t);
    const gateway = await startTestGateway({ events: [profile] });
    t.after(() => gateway.close());

    const expiresAt = CONSTANTS.now + 600;
    const secret = grantFrom(CONSTANTS.tenant.root_secret, MEMBER.public_key, expiresAt);
    const accepted = await gateway.handover(handoverFor({ expiresAt }));
    const refused = await gateway.handover(
      handoverFor({ expiresAt, workloadId: OTHER_WORKLOAD }),
    );

    for (const answered of [accepted, refused]) {
      assert.doesNotMatch(answered.body, new RegExp(secret, 'i'));
    }
    assert.doesNotMatch(gateway.log.join('\n'), new RegExp(secret, 'i'));
  });
});
