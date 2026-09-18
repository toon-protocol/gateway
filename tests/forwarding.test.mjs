// Forwarding: what a tenant's request becomes on its way to the workload.
//
// Driven at the gateway's own listening port, against real stub connectors and
// a real stub workload. Nothing here looks inside the gateway: what is asserted
// is what ARRIVED — at the workload, and at each Standby Set member.

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import WebSocket from 'ws';

import { CONSTANTS, providerProfile } from './helpers/events.mjs';
import { gatewayHandover, grantFrom } from './helpers/handover.mjs';
import { admitAll, startTestGateway, until } from './helpers/harness.mjs';
import { running, startStubConnector } from './helpers/stub-connector.mjs';
import { startStubWorkload } from './helpers/stub-workload.mjs';

const WORKLOAD = 'aa'.repeat(32);
const HTTP_PORT = 8080;

/** The Standby Set of the tests below: primary first, as a handover lists it. */
const MEMBERS = [CONSTANTS.primary_provider, CONSTANTS.standby_provider, CONSTANTS.provider];

/**
 * One stub connector per member, each with a Provider Profile pointing at it.
 *
 * `answers[i]` is what member `i` answers, in `standby_set` order.
 */
async function standbySet(t, answers) {
  const connectors = [];
  const profiles = [];
  for (const [index, key] of MEMBERS.entries()) {
    const connector = await startStubConnector({ pubkey: key.public_key, answer: answers[index] });
    t.after(() => connector.close());
    connectors.push(connector);
    profiles.push(
      providerProfile({ providerSecret: key.secret_key, connectorUrl: connector.url, relays: [] }),
    );
  }
  return { connectors, profiles };
}

const EXPIRES_AT = CONSTANTS.now + 86_400;

const handoverFor = (overrides = {}) =>
  gatewayHandover({
    workloadId: WORKLOAD,
    httpPort: HTTP_PORT,
    standbySet: MEMBERS.map((m) => m.public_key),
    expiresAt: EXPIRES_AT,
    ...overrides,
  });

const notRunning = (state) => ({ workloadId }) => ({
  workload_id: workloadId,
  role: 'standby',
  state,
  expires_at: CONSTANTS.now + 3600,
});

describe('forwarding to the running member', () => {
  it('reaches the workload, which sees the tenant\'s Host and the forwarding headers', async (t) => {
    const workload = await startStubWorkload({ body: 'the application answered' });
    t.after(() => workload.close());

    const { connectors, profiles } = await standbySet(t, [
      notRunning('reserved'),
      ({ workloadId }) =>
        running({
          workloadId,
          host: workload.host,
          ports: [{ container_port: HTTP_PORT, host_port: workload.port }],
        }),
      notRunning('stopped'),
    ]);

    const gateway = await startTestGateway({
      events: profiles,
      handovers: [handoverFor()],
      probe: admitAll,
    });
    t.after(() => gateway.close());

    const host = gateway.hostFor(WORKLOAD);
    const answered = await gateway.get(host, { path: '/orders?page=2' });

    assert.equal(answered.status, 200);
    assert.equal(answered.body, 'the application answered');

    const [reached] = workload.requests;
    assert.equal(reached.url, '/orders?page=2');
    assert.equal(reached.headers.host, host, 'the application sees the name the tenant used');
    assert.equal(reached.headers['x-forwarded-host'], host);
    assert.equal(reached.headers['x-forwarded-proto'], 'http', 'the plain development listener');
    assert.equal(reached.headers['x-forwarded-for'], '127.0.0.1');

    // Every member was asked, each presenting the grant derived for ITS OWN
    // key: one value per member, because §6.5.1 derives under the member's key.
    for (const [index, connector] of connectors.entries()) {
      const [asked] = connector.requests;
      assert.ok(asked !== undefined, `member ${index} was not asked`);
      assert.equal(asked.path, '/status');
      assert.equal(asked.request.sig, undefined, 'nobody signs a Lease Request');
      assert.equal(
        asked.continuation,
        grantFrom(CONSTANTS.tenant.root_secret, MEMBERS[index].public_key, EXPIRES_AT),
        'the grant this member\'s own token derives',
      );
      assert.equal(asked.gatewayExpiresAt, EXPIRES_AT);
      assert.equal(asked.content.workload_id, WORKLOAD);
      assert.equal(asked.request.provider, MEMBERS[index].public_key, 'addressed to that member');
      assert.equal(asked.request.op, 'status');
      // The §6.1 window: a provider refuses a request without one.
      assert.ok(
        asked.request.expiration > CONSTANTS.now && asked.request.expiration - CONSTANTS.now <= 300,
        `a window a provider will accept, got ${asked.request.expiration}`,
      );
    }

    // No two members were handed the same value: one member cannot replay
    // another's grant, which is what the per-provider derivation is for.
    const presented = connectors.map((connector) => connector.requests[0].continuation);
    assert.equal(new Set(presented).size, MEMBERS.length);

    // And `status` was the ONLY thing asked of anybody. It is a free route
    // (spec §5): this gateway holds no lease and calls nothing that is priced.
    for (const connector of connectors) {
      assert.deepEqual(
        [...new Set(connector.requests.map((asked) => asked.path))],
        ['/status'],
        'a gateway calls no route but `status`',
      );
    }
  });

  it('takes the member earliest in `standby_set` when two answer `running`', async (t) => {
    const primary = await startStubWorkload({ body: 'the primary' });
    const standby = await startStubWorkload({ body: 'the standby' });
    for (const stub of [primary, standby]) t.after(() => stub.close());

    const runningAt = (port) => ({ workloadId }) =>
      running({
        workloadId,
        host: '127.0.0.1',
        ports: [{ container_port: HTTP_PORT, host_port: port }],
      });

    // A Takeover settled in two places for an instant. Both are telling the
    // truth; every gateway holding this grant must still choose the same one.
    const { profiles } = await standbySet(t, [
      runningAt(primary.port),
      runningAt(standby.port),
      notRunning('reserved'),
    ]);

    const gateway = await startTestGateway({
      events: profiles,
      handovers: [handoverFor()],
      probe: admitAll,
    });
    t.after(() => gateway.close());

    assert.equal((await gateway.get(gateway.hostFor(WORKLOAD))).body, 'the primary');
  });

  it('says `https` to the workload when the tenant arrived over TLS', async (t) => {
    const workload = await startStubWorkload({ body: 'over TLS' });
    t.after(() => workload.close());

    const { profiles } = await standbySet(t, [
      ({ workloadId }) =>
        running({
          workloadId,
          host: workload.host,
          ports: [{ container_port: HTTP_PORT, host_port: workload.port }],
        }),
      notRunning('reserved'),
      notRunning('reserved'),
    ]);

    const gateway = await startTestGateway({
      events: profiles,
      handovers: [handoverFor()],
      probe: admitAll,
      tls: true,
      http: false,
    });
    t.after(() => gateway.close());

    const answered = await gateway.get(gateway.hostFor(WORKLOAD));
    assert.equal(answered.status, 200);
    assert.equal(workload.requests[0].headers['x-forwarded-proto'], 'https');
  });

  it('forwards to the host port of the handover\'s `http_port`, not the first port and not SSH', async (t) => {
    // Three servers, so picking the wrong one is a WRONG BODY rather than a
    // coincidence: the first port listed is a database, the SSH port is a real
    // listener too, and only the third is the application.
    const database = await startStubWorkload({ body: 'the first port listed' });
    const ssh = await startStubWorkload({ body: 'the SSH port' });
    const workload = await startStubWorkload({ body: 'the application answered' });
    for (const stub of [database, ssh, workload]) t.after(() => stub.close());

    const { profiles } = await standbySet(t, [
      ({ workloadId }) =>
        running({
          workloadId,
          host: workload.host,
          sshPort: ssh.port,
          ports: [
            { container_port: 5432, host_port: database.port },
            { container_port: HTTP_PORT, host_port: workload.port },
          ],
        }),
      notRunning('reserved'),
      notRunning('reserved'),
    ]);

    const gateway = await startTestGateway({
      events: profiles,
      handovers: [handoverFor()],
      probe: admitAll,
    });
    t.after(() => gateway.close());

    const answered = await gateway.get(gateway.hostFor(WORKLOAD));
    assert.equal(answered.body, 'the application answered');
    assert.equal(database.requests.length, 0, 'the first port listed is not the HTTP one');
    assert.equal(ssh.requests.length, 0, 'and neither is SSH');
  });

  it('passes a WebSocket upgrade through, both ways', async (t) => {
    const workload = await startStubWorkload({ websocket: true });
    t.after(() => workload.close());

    const { profiles } = await standbySet(t, [
      ({ workloadId }) =>
        running({
          workloadId,
          host: workload.host,
          ports: [{ container_port: HTTP_PORT, host_port: workload.port }],
        }),
      notRunning('reserved'),
      notRunning('reserved'),
    ]);

    const gateway = await startTestGateway({
      events: profiles,
      handovers: [handoverFor()],
      probe: admitAll,
    });
    t.after(() => gateway.close());

    const host = gateway.hostFor(WORKLOAD);
    const socket = new WebSocket(`ws://127.0.0.1:${gateway.httpPort}/live`, {
      headers: { host },
    });
    t.after(() => socket.close());

    /** @type {string[]} */
    const heard = [];
    socket.on('message', (raw) => heard.push(String(raw)));
    await new Promise((opened, failed) => {
      socket.once('open', () => opened(undefined));
      socket.once('error', failed);
    });

    socket.send('from the tenant');
    await until(() => heard.length === 1, { what: 'the workload to answer over the socket' });

    assert.deepEqual(heard, ['echo:from the tenant'], 'the answer came back through the gateway');
    const [upgraded] = workload.upgrades;
    assert.equal(upgraded.url, '/live');
    assert.equal(upgraded.headers.host, host, 'the application sees the tenant\'s Host here too');
    assert.equal(upgraded.headers['x-forwarded-host'], host);
    assert.deepEqual(upgraded.messages, ['from the tenant']);
  });
});
