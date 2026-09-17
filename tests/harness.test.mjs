// The harness itself, proven at the seams the rest of Milestone 5 uses.
//
// Read this file first if you are writing M5-4, M5-5 or M5-6: each test here
// is the smallest working example of one thing the harness gives you.

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { request as httpRequest } from 'node:http';

import { K_TAKEOVER } from '../src/kinds.mjs';
import { CONSTANTS, gatewayGrant, providerProfile, takeover } from './helpers/events.mjs';
import { startTestGateway, until } from './helpers/harness.mjs';
import { running, startStubConnector } from './helpers/stub-connector.mjs';
import { startStubWorkload } from './helpers/stub-workload.mjs';
import { signEvent } from '../src/nostr.mjs';
import { K_LEASE_REQUEST } from '../src/kinds.mjs';

const GATEWAY = CONSTANTS.gateway;
const WORKLOAD = 'aa'.repeat(32);

const post = (url, body) =>
  new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const target = new URL(url);
    const req = httpRequest(
      { host: target.hostname, port: target.port, path: target.pathname, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
      },
    );
    req.on('error', reject);
    req.end(payload);
  });

describe('the stub provider connector', () => {
  // M5-4 starts one of these per Standby Set member and tells each what to
  // answer. This is the whole shape of a granted `status` (spec §6.5).
  it('answers a `status` a gateway signed, carrying the grant, as a provider would', async (t) => {
    const grant = gatewayGrant({ workloadId: WORKLOAD, gateway: GATEWAY.public_key, httpPort: 8080 });
    const connector = await startStubConnector({
      pubkey: CONSTANTS.provider.public_key,
      answer: ({ workloadId }) =>
        running({ workloadId, host: '203.0.113.7', ports: [{ container_port: 8080, host_port: 41000 }] }),
    });
    t.after(() => connector.close());

    const request = signEvent(GATEWAY.secret_key, {
      kind: K_LEASE_REQUEST,
      created_at: CONSTANTS.now,
      tags: [['p', CONSTANTS.provider.public_key], ['op', 'status'], ['expiration', String(CONSTANTS.now + 60)]],
      content: JSON.stringify({ workload_id: WORKLOAD, grant }),
    });
    const answered = await post(`${connector.url}/status`, { request });

    assert.equal(answered.status, 200);
    assert.equal(answered.json.state, 'running');
    assert.equal(answered.json.access.ports[0].host_port, 41000);

    const [recorded] = connector.requests;
    assert.equal(recorded.path, '/status');
    assert.equal(recorded.signer, GATEWAY.public_key, 'the GATEWAY signs, not the tenant');
    assert.equal(recorded.grant.id, grant.id, 'and carries the grant inside its content');
  });

  it('can answer anything a member might answer, or nothing at all', async (t) => {
    const connector = await startStubConnector({ pubkey: CONSTANTS.provider.public_key });
    t.after(() => connector.close());

    // Default: a workload this provider never leased.
    assert.equal((await post(`${connector.url}/status`, { request: { content: '{}' } })).json.error, 'unknown_workload');

    connector.answerWith(() => ({ workload_id: WORKLOAD, role: 'standby', state: 'reserved', expires_at: CONSTANTS.now + 3600 }));
    assert.equal((await post(`${connector.url}/status`, { request: { content: '{}' } })).json.state, 'reserved');

    // A member that connects and never replies: M5-4's `member_unreachable`.
    connector.goSilent();
    await assert.rejects(
      Promise.race([
        post(`${connector.url}/status`, { request: { content: '{}' } }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('no answer')), 100)),
      ]),
      /no answer/,
    );
  });
});

describe('the stub workload', () => {
  // M5-4 asserts on exactly this: the Host the tenant used, and the
  // X-Forwarded-* headers that say the request came through a gateway.
  it('records what reached it, through a resolver that forwards', async (t) => {
    const workload = await startStubWorkload({ body: 'the application answered' });
    t.after(() => workload.close());

    // A toy forwarder, NOT the real one: M5-4 writes that, in `src/`.
    const forward = async ({ req, res }) =>
      new Promise((resolve) => {
        const upstream = httpRequest(
          {
            host: workload.host,
            port: workload.port,
            path: req.url,
            method: req.method,
            headers: { ...req.headers, 'x-forwarded-host': req.headers.host, 'x-forwarded-proto': 'https' },
          },
          (upstreamRes) => {
            res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
            upstreamRes.pipe(res);
            upstreamRes.on('end', () => resolve({ served: true }));
          },
        );
        req.pipe(upstream);
      });

    const gateway = await startTestGateway({
      events: [gatewayGrant({ workloadId: WORKLOAD, gateway: GATEWAY.public_key })],
      resolve: forward,
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
  });
});

describe('the stub relay', () => {
  // M5-5 publishes a Takeover mid-test and asserts that forwarding moved.
  it('delivers an event published mid-test to a subscription already open', async (t) => {
    const gateway = await startTestGateway({});
    t.after(() => gateway.close());

    /** @type {object[]} */
    const seen = [];
    const subscription = gateway.gateway.pool.subscribe({
      relays: [gateway.relay.url],
      filters: [{ kinds: [K_TAKEOVER], '#d': [WORKLOAD] }],
      onEvent: (event) => seen.push(event),
    });
    t.after(() => subscription.close());

    const claim = takeover({ workloadId: WORKLOAD });
    gateway.publish(claim);
    await until(() => seen.length === 1, { what: 'the Takeover to arrive' });
    assert.equal(seen[0].id, claim.id);
    assert.equal(JSON.parse(seen[0].content).primary, CONSTANTS.primary_provider.public_key);
  });

  it('holds Provider Profiles, so a resolver can read `connector_url` and relays', async (t) => {
    const connector = await startStubConnector({ pubkey: CONSTANTS.provider.public_key });
    t.after(() => connector.close());

    const profile = providerProfile({ connectorUrl: connector.url, relays: ['ws://relay.one:7100'] });
    const gateway = await startTestGateway({ events: [profile] });
    t.after(() => gateway.close());

    /** @type {object[]} */
    const seen = [];
    const subscription = gateway.gateway.pool.subscribe({
      relays: [gateway.relay.url],
      filters: [{ kinds: [profile.kind], authors: [CONSTANTS.provider.public_key] }],
      onEvent: (event) => seen.push(event),
    });
    t.after(() => subscription.close());

    await until(() => seen.length === 1, { what: 'the Profile to arrive' });
    assert.equal(JSON.parse(seen[0].content).connector_url, connector.url);
  });

  it('replaces an addressable event the way a relay does', async (t) => {
    const gateway = await startTestGateway({});
    t.after(() => gateway.close());

    const first = gatewayGrant({ workloadId: WORKLOAD, gateway: GATEWAY.public_key, createdAt: CONSTANTS.now });
    const later = gatewayGrant({ workloadId: WORKLOAD, gateway: GATEWAY.public_key, createdAt: CONSTANTS.now + 10 });
    assert.equal(gateway.publish(first), true);
    assert.equal(gateway.publish(later), true);
    assert.equal(gateway.relay.events.filter((e) => e.kind === later.kind).length, 1);
    assert.equal(gateway.publish(first), false, 'an older one is refused, as a relay refuses it');
  });
});
