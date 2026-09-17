// The gateway, end to end, at its own listening port.
//
// Everything here is driven the way a tenant drives it: publish a grant to a
// relay, ask the gateway for a hostname, read what it answered. Nothing looks
// inside the gateway.

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { canonicalLabel } from '../src/hostname.mjs';
import { K_GATEWAY_GRANT } from '../src/kinds.mjs';
import { CONSTANTS, gatewayGrant } from './helpers/events.mjs';
import { DOMAIN, startTestGateway } from './helpers/harness.mjs';
import { startStubConnector } from './helpers/stub-connector.mjs';

const GATEWAY = CONSTANTS.gateway.public_key;
const WORKLOAD = 'aa'.repeat(32);
const OTHER_WORKLOAD = 'bb'.repeat(32);
const grantFor = (overrides = {}) =>
  gatewayGrant({ workloadId: WORKLOAD, gateway: GATEWAY, ...overrides });

/** A resolver that answers with what it was given, so a test can see it. */
const echoGrant = async ({ grant, res }) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ workloadId: grant.workloadId, httpPort: grant.httpPort, name: grant.name ?? null }));
  return { served: true };
};

describe('grant discovery', () => {
  it('serves a workload whose grant was already on the relay, with no contact from the tenant', async (t) => {
    const gateway = await startTestGateway({ events: [grantFor()], resolve: echoGrant });
    t.after(() => gateway.close());

    const answered = await gateway.get(gateway.hostFor(WORKLOAD));
    assert.equal(answered.status, 200);
    assert.equal(answered.json().workloadId, WORKLOAD);
  });

  it('finds every grant naming it with ONE filter: kind 30438, #p its own key', async (t) => {
    const gateway = await startTestGateway({ resolve: echoGrant });
    t.after(() => gateway.close());

    const grantRequests = gateway.relay.requests.filter((r) =>
      r.filters.some((f) => f.kinds?.includes(K_GATEWAY_GRANT)),
    );
    assert.equal(grantRequests.length, 1, 'one subscription, not one per workload');
    assert.equal(grantRequests[0].filters.length, 1);
    assert.deepEqual(grantRequests[0].filters[0], { kinds: [K_GATEWAY_GRANT], '#p': [GATEWAY] });
  });

  it('picks up a grant published while it is running', async (t) => {
    const gateway = await startTestGateway({ resolve: echoGrant });
    t.after(() => gateway.close());

    const host = gateway.hostFor(WORKLOAD);
    assert.equal((await gateway.get(host)).status, 503);

    gateway.publish(grantFor());
    await gateway.untilServed(host);
    assert.equal((await gateway.get(host)).json().workloadId, WORKLOAD);
  });

  it('replaces the grant it holds when a later one for the same workload arrives', async (t) => {
    const gateway = await startTestGateway({
      events: [grantFor({ createdAt: 1700000000, httpPort: 8080 })],
      resolve: echoGrant,
    });
    t.after(() => gateway.close());

    const host = gateway.hostFor(WORKLOAD);
    assert.equal((await gateway.get(host)).json().httpPort, 8080);

    gateway.publish(grantFor({ createdAt: 1700000100, httpPort: 9090, name: 'shop' }));
    await import('./helpers/harness.mjs').then(({ until }) =>
      until(async () => (await gateway.get(host)).json().httpPort === 9090, {
        what: 'the later grant to replace the earlier one',
      }),
    );
    const answered = await gateway.get(host);
    assert.equal(answered.json().httpPort, 9090);
    assert.equal(answered.json().name, 'shop', '`name` is carried, for M5-4 to serve');
  });

  it('does not serve a workload granted to another gateway', async (t) => {
    const elsewhere = gatewayGrant({ workloadId: WORKLOAD, gateway: 'cc'.repeat(32) });
    const gateway = await startTestGateway({ events: [elsewhere], resolve: echoGrant });
    t.after(() => gateway.close());

    const answered = await gateway.get(gateway.hostFor(WORKLOAD));
    assert.equal(answered.status, 503);
    assert.equal(answered.headers['toon-gateway-reason'], 'no_grant');
  });

  it('keeps serving the others when a malformed grant arrives', async (t) => {
    const gateway = await startTestGateway({ events: [grantFor()], resolve: echoGrant });
    t.after(() => gateway.close());

    gateway.publish({ id: 'f'.repeat(64), pubkey: 'f'.repeat(64), sig: 'f'.repeat(128), kind: K_GATEWAY_GRANT, created_at: 1700000000, tags: [['d', OTHER_WORKLOAD], ['p', GATEWAY]], content: '{}' });
    const answered = await gateway.get(gateway.hostFor(WORKLOAD));
    assert.equal(answered.status, 200);
  });
});

describe('the canonical hostname', () => {
  it('serves the lowercase unpadded base32 of the workload id, under its domain', async (t) => {
    const gateway = await startTestGateway({ events: [grantFor()], resolve: echoGrant });
    t.after(() => gateway.close());

    const host = `vkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkva.${DOMAIN}`;
    assert.equal(host, gateway.hostFor(WORKLOAD));
    assert.equal((await gateway.get(host)).status, 200);
  });

  it('recognises the hostname however DNS spelled it: case, port, trailing dot', async (t) => {
    const gateway = await startTestGateway({ events: [grantFor()], resolve: echoGrant });
    t.after(() => gateway.close());

    const label = canonicalLabel(WORKLOAD);
    for (const host of [`${label.toUpperCase()}.${DOMAIN}`, `${label}.${DOMAIN}:8443`, `${label}.${DOMAIN}.`]) {
      assert.equal((await gateway.get(host)).status, 200, host);
    }
  });

  it('is not the hex workload id, which no DNS label could hold', async (t) => {
    const gateway = await startTestGateway({ events: [grantFor()], resolve: echoGrant });
    t.after(() => gateway.close());

    const answered = await gateway.get(`${WORKLOAD}.${DOMAIN}`);
    assert.equal(answered.status, 503);
    assert.equal(answered.headers['toon-gateway-reason'], 'no_grant');
  });
});

describe('the error page', () => {
  it('answers a hostname with no grant 503, naming that reason', async (t) => {
    const gateway = await startTestGateway({ resolve: echoGrant });
    t.after(() => gateway.close());

    const answered = await gateway.get(gateway.hostFor(OTHER_WORKLOAD));
    assert.equal(answered.status, 503);
    assert.equal(answered.headers['toon-gateway-reason'], 'no_grant');
    assert.equal(answered.json().error, 'no_grant');
    assert.match(answered.json().message, /no grant for this hostname/i);
  });

  it('tells an expired grant apart from a workload nobody granted', async (t) => {
    let now = 1700000000;
    const gateway = await startTestGateway({
      events: [grantFor({ expiresAt: 1700000100 })],
      resolve: echoGrant,
      now: () => now,
    });
    t.after(() => gateway.close());

    const host = gateway.hostFor(WORKLOAD);
    assert.equal((await gateway.get(host)).status, 200);

    now = 1700000101;
    const answered = await gateway.get(host);
    assert.equal(answered.status, 503);
    assert.equal(answered.headers['toon-gateway-reason'], 'grant_expired');
    assert.match(answered.json().message, /expired/i);

    // And it starts serving again the moment the tenant republishes, with no
    // restart: renewal and publication are the same act (spec §3.1.3).
    gateway.publish(grantFor({ createdAt: 1700000200, expiresAt: 1700009999 }));
    await gateway.untilServed(host);
  });

  it('says a granted workload is not resolved yet, rather than saying nothing', async (t) => {
    // The gateway with no resolver at all: M5-3 stops one step short of the
    // workload, and a tenant must still be able to tell that from a broken
    // gateway.
    const gateway = await startTestGateway({ events: [grantFor()] });
    t.after(() => gateway.close());

    const answered = await gateway.get(gateway.hostFor(WORKLOAD));
    assert.equal(answered.status, 503);
    assert.equal(answered.headers['toon-gateway-reason'], 'not_resolved');
    assert.match(answered.json().message, new RegExp(WORKLOAD));
  });

  it('answers a browser a page it can read, and JSON to everything else', async (t) => {
    const gateway = await startTestGateway({});
    t.after(() => gateway.close());

    const host = gateway.hostFor(OTHER_WORKLOAD);
    const page = await gateway.get(host, { headers: { accept: 'text/html,*/*' } });
    assert.match(String(page.headers['content-type']), /text\/html/);
    assert.match(page.body, /no_grant/);

    const json = await gateway.get(host);
    assert.match(String(json.headers['content-type']), /application\/json/);
  });

  it('refuses a WebSocket upgrade to an ungranted hostname with the same reason', async (t) => {
    const gateway = await startTestGateway({});
    t.after(() => gateway.close());

    const answered = await gateway.get(gateway.hostFor(OTHER_WORKLOAD), {
      headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' },
    });
    assert.equal(answered.status, 503);
    assert.equal(answered.headers['toon-gateway-reason'], 'no_grant');
  });
});

describe('a hostname nobody granted', () => {
  it('never reaches a provider or a workload', async (t) => {
    const connector = await startStubConnector({ pubkey: CONSTANTS.provider.public_key });
    t.after(() => connector.close());

    let resolverCalls = 0;
    const gateway = await startTestGateway({
      events: [grantFor()],
      resolve: async (context) => {
        resolverCalls += 1;
        return echoGrant(context);
      },
    });
    t.after(() => gateway.close());

    for (const host of [
      gateway.hostFor(OTHER_WORKLOAD),      // a workload nobody granted us
      DOMAIN,                                // the bare gateway domain
      `deep.${canonicalLabel(WORKLOAD)}.${DOMAIN}`, // not one label under it
      `${canonicalLabel(WORKLOAD)}.elsewhere.example`, // not our domain at all
      '127.0.0.1',                           // an address, not a name
    ]) {
      const answered = await gateway.get(host);
      assert.equal(answered.status, 503, host);
      assert.equal(answered.headers['toon-gateway-reason'], 'no_grant', host);
    }

    assert.equal(resolverCalls, 0, 'nothing was resolved');
    assert.equal(connector.requests.length, 0, 'no provider was asked anything');
  });
});
