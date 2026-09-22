// The harness itself, proven at the seams the gateway tests use.
//
// Read this file first if you are writing a gateway test: each test here is
// the smallest working example of one thing the harness gives you.

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { request as httpRequest } from 'node:http';

import { K_PROFILE, K_TAKEOVER } from '../src/kinds.mjs';
import { createConnectors } from '../src/status.mjs';
import { CONSTANTS, FIXTURE_SEAL_KEY, providerProfile, takeover } from './helpers/events.mjs';
import { gatewayHandover, grantFrom } from './helpers/handover.mjs';
import { admitAll, startTestGateway, until } from './helpers/harness.mjs';
import { running, startStubConnector } from './helpers/stub-connector.mjs';
import { startStubWorkload } from './helpers/stub-workload.mjs';

const WORKLOAD = 'aa'.repeat(32);

/**
 * Ask a stub connector for `status` THE WAY THE GATEWAY DOES: the sealed
 * packet, through `src/status.mjs`'s own carriage.
 *
 * There is deliberately no shortcut here. A helper that POSTed the body at
 * some path would be testing a connector nobody deploys, which is precisely
 * the bug this carriage replaced (TOON_Network#114): the only thing that gets
 * an answer out of a real connector is a packet it can unseal.
 */
const profileOf = (connector) => ({
  connectorUrl: connector.url,
  ilpAddress: connector.ilpAddress,
  connectorSealKey: FIXTURE_SEAL_KEY,
});

const asker = (t, { timeoutMs = 2000 } = {}) => {
  const connectors = createConnectors({ timeoutMs });
  t.after(() => connectors.close());
  return (connector, request) => connectors.ask({ profile: profileOf(connector), request });
};

describe('the stub provider connector', () => {
  // Resolution starts one of these per Standby Set member and tells each what
  // to answer. This is the whole shape of a delegated `status` (spec §6.5.1).
  it('answers a `status` presenting a Gateway Grant, as a provider would', async (t) => {
    const expiresAt = CONSTANTS.now + 86_400;
    const grant = grantFrom(CONSTANTS.tenant.root_secret, CONSTANTS.provider.public_key, expiresAt);
    const connector = await startStubConnector({
      pubkey: CONSTANTS.provider.public_key,
      answer: ({ workloadId }) =>
        running({ workloadId, host: '203.0.113.7', ports: [{ container_port: 8080, host_port: 41000 }] }),
    });
    t.after(() => connector.close());

    const request = {
      request_id: 'ab'.repeat(32),
      op: 'status',
      provider: CONSTANTS.provider.public_key,
      expiration: CONSTANTS.now + 60,
      continuation: grant,
      content: { workload_id: WORKLOAD, gateway_expires_at: expiresAt },
    };
    const answered = await asker(t)(connector, request);

    assert.equal(answered.status, 200);
    assert.equal(answered.body.state, 'running');
    assert.equal(answered.body.access.ports[0].host_port, 41000);

    const [recorded] = connector.requests;
    assert.equal(recorded.destination, connector.destination, 'addressed `<ilp_address>.status`');
    assert.equal(recorded.target, '', 'and at the route\'s own handler, with no path beneath it');
    assert.deepEqual(Object.keys(recorded.body), ['request'], 'the packet body of §6.1.2');
    assert.equal(recorded.continuation, grant, 'the grant rides in `continuation`');
    assert.equal(recorded.gatewayExpiresAt, expiresAt, 'naming the moment it was derived for');
    assert.equal(recorded.request.sig, undefined, 'and nobody signed it');
  });

  it('can answer anything a member might answer, or nothing at all', async (t) => {
    const connector = await startStubConnector({ pubkey: CONSTANTS.provider.public_key });
    t.after(() => connector.close());

    const ask = asker(t, { timeoutMs: 400 });
    const asking = { content: {} };
    // Default: a workload this provider never leased.
    assert.equal((await ask(connector, asking)).body.error, 'unknown_workload');

    connector.answerWith(() => ({ workload_id: WORKLOAD, role: 'standby', state: 'reserved', expires_at: CONSTANTS.now + 3600 }));
    assert.equal((await ask(connector, asking)).body.state, 'reserved');

    // Something that is NOT this connector in front of it — an nginx that
    // 404s the client edge. The carriage fails; nothing is learned about the
    // lease, and `src/resolve.mjs` counts that with silence.
    connector.edgeAnswers(() => ({ status: 404, body: '' }));
    await assert.rejects(ask(connector, asking));
    connector.edgeAnswers(undefined);

    // A member that connects and never replies: `member_unreachable`.
    connector.goSilent();
    await assert.rejects(ask(connector, asking), /within 400 ms/);
  });
});

describe('the stub workload', () => {
  // M5-4 asserts on exactly this: the Host the tenant used, and the
  // X-Forwarded-* headers that say the request came through a gateway.
  it('records what reached it, through a resolver that forwards', async (t) => {
    const workload = await startStubWorkload({ body: 'the application answered' });
    t.after(() => workload.close());

    // A toy forwarder, NOT the real one: M5-4 writes that, in `src/`.
    /** @type {import('../src/serve.mjs').Resolver} */
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
      handovers: [gatewayHandover({ workloadId: WORKLOAD })],
      probe: admitAll,
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

  it('replaces a replaceable event the way a relay does', async (t) => {
    const gateway = await startTestGateway({});
    t.after(() => gateway.close());

    const first = providerProfile({ connectorUrl: 'http://one.example', createdAt: CONSTANTS.now });
    const later = providerProfile({ connectorUrl: 'http://two.example', createdAt: CONSTANTS.now + 10 });
    assert.equal(gateway.publish(first), true);
    assert.equal(gateway.publish(later), true);
    assert.equal(gateway.relay.events.filter((e) => e.kind === K_PROFILE).length, 1);
    assert.equal(gateway.publish(first), false, 'an older one is refused, as a relay refuses it');
  });
});

describe('the handover port', () => {
  // The other seam a tenant has: where this gateway's connector forwards a
  // sealed Gateway Handover (spec §12.1). A test that is about something
  // downstream of admission passes `admitAll` and gets one admitted with no
  // member asked.
  it('admits a handover and answers where the workload is now served', async (t) => {
    const gateway = await startTestGateway({ probe: admitAll });
    t.after(() => gateway.close());

    const answered = await gateway.handover(gatewayHandover({ workloadId: WORKLOAD }));
    assert.equal(answered.status, 200);
    assert.equal(answered.json().hostname, gateway.hostFor(WORKLOAD));
  });
});
