// The gateway, end to end, at its own listening port.
//
// Everything here is driven the way a tenant drives it: publish a grant to a
// relay, ask the gateway for a hostname, read what it answered. Nothing looks
// inside the gateway.

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { canonicalLabel } from '../src/hostname.mjs';
import { K_TAKEOVER } from '../src/kinds.mjs';
import { CONSTANTS } from './helpers/events.mjs';
import { gatewayHandover } from './helpers/handover.mjs';
import { DOMAIN, admitAll, startTestGateway, until } from './helpers/harness.mjs';
import { startStubConnector } from './helpers/stub-connector.mjs';

const WORKLOAD = 'aa'.repeat(32);
const OTHER_WORKLOAD = 'bb'.repeat(32);
const handoverFor = (overrides = {}) => gatewayHandover({ workloadId: WORKLOAD, ...overrides });

/**
 * A resolver that answers with what it was given, so a test can see it.
 *
 * Every test here is about the HOSTNAME, so both seams downstream of it are
 * stubbed: `admitAll` for the round a handover is admitted on, this for where
 * the workload runs.
 * @type {import('../src/serve.mjs').Resolver}
 */
const echoGrant = async ({ grant, res }) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ workloadId: grant.workloadId, httpPort: grant.httpPort, name: grant.name ?? null }));
  return { served: true };
};

describe('being handed a workload', () => {
  it('serves a workload a tenant sealed one packet for, holding no account for it', async (t) => {
    const gateway = await startTestGateway({ probe: admitAll, resolve: echoGrant });
    t.after(() => gateway.close());

    const host = gateway.hostFor(WORKLOAD);
    assert.equal((await gateway.get(host)).status, 503);

    const answered = await gateway.handover(handoverFor());
    assert.equal(answered.status, 200);
    assert.equal(answered.json().hostname, host);
    assert.equal((await gateway.get(host)).json().workloadId, WORKLOAD);
  });

  it('watches no relay for a grant: there is nothing published to find', async (t) => {
    const gateway = await startTestGateway({ probe: admitAll, resolve: echoGrant });
    t.after(() => gateway.close());

    await gateway.handover(handoverFor());
    // Kind 30438 is gone (ADR 0016) and so is the `#p` filter that found it.
    // What is left on a workload's account is its members' Profiles and its
    // Takeovers, and both are opened by the workloads being served.
    const kinds = gateway.relay.requests.flatMap((r) => r.filters.flatMap((f) => f.kinds ?? []));
    assert.equal(kinds.includes(30438), false, 'no grant filter');
    assert.equal(
      gateway.relay.requests.some((r) => r.filters.some((f) => f['#p'] !== undefined)),
      false,
      'nothing is subscribed to on this gateway\'s own key',
    );
  });

  it('replaces the grant it holds when a later handover is admitted', async (t) => {
    const gateway = await startTestGateway({
      probe: admitAll,
      resolve: echoGrant,
      handovers: [handoverFor({ httpPort: 8080 })],
    });
    t.after(() => gateway.close());

    const host = gateway.hostFor(WORKLOAD);
    assert.equal((await gateway.get(host)).json().httpPort, 8080);

    await gateway.handover(handoverFor({ httpPort: 9090, name: 'shop' }));
    const answered = await gateway.get(host);
    assert.equal(answered.json().httpPort, 9090);
    assert.equal(answered.json().name, 'shop', '`name` is carried, for §12.6 to serve');
  });

  it('keeps serving a workload whose handover carried an unusable name', async (t) => {
    const gateway = await startTestGateway({
      probe: admitAll,
      resolve: echoGrant,
      handovers: [handoverFor({ name: 'not a label' })],
    });
    t.after(() => gateway.close());

    const answered = await gateway.get(gateway.hostFor(WORKLOAD));
    assert.equal(answered.status, 200, 'the canonical hostname is not lost to a bad name');
    assert.equal(answered.json().name, null);
  });

  it('keeps serving the others when a handover that is not one arrives', async (t) => {
    const gateway = await startTestGateway({
      probe: admitAll,
      resolve: echoGrant,
      handovers: [handoverFor()],
    });
    t.after(() => gateway.close());

    const refused = await gateway.handover({ handover: { workload_id: OTHER_WORKLOAD } });
    assert.equal(refused.json().error, 'invalid_handover');
    assert.equal((await gateway.get(gateway.hostFor(WORKLOAD))).status, 200);
  });
});

describe('the canonical hostname', () => {
  it('serves the lowercase unpadded base32 of the workload id, under its domain', async (t) => {
    const gateway = await startTestGateway({ probe: admitAll, resolve: echoGrant, handovers: [handoverFor()] });
    t.after(() => gateway.close());

    const host = `vkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkva.${DOMAIN}`;
    assert.equal(host, gateway.hostFor(WORKLOAD));
    assert.equal((await gateway.get(host)).status, 200);
  });

  it('recognises the hostname however DNS spelled it: case, port, trailing dot', async (t) => {
    const gateway = await startTestGateway({ probe: admitAll, resolve: echoGrant, handovers: [handoverFor()] });
    t.after(() => gateway.close());

    const label = canonicalLabel(WORKLOAD);
    for (const host of [`${label.toUpperCase()}.${DOMAIN}`, `${label}.${DOMAIN}:8443`, `${label}.${DOMAIN}.`]) {
      assert.equal((await gateway.get(host)).status, 200, host);
    }
  });

  it('is not the hex workload id, which no DNS label could hold', async (t) => {
    const gateway = await startTestGateway({ probe: admitAll, resolve: echoGrant, handovers: [handoverFor()] });
    t.after(() => gateway.close());

    const answered = await gateway.get(`${WORKLOAD}.${DOMAIN}`);
    assert.equal(answered.status, 503);
    assert.equal(answered.headers['toon-gateway-reason'], 'no_grant');
  });
});

describe('the error page', () => {
  it('answers a hostname with no grant 503, naming that reason', async (t) => {
    const gateway = await startTestGateway({ probe: admitAll, resolve: echoGrant });
    t.after(() => gateway.close());

    const answered = await gateway.get(gateway.hostFor(OTHER_WORKLOAD));
    assert.equal(answered.status, 503);
    assert.equal(answered.headers['toon-gateway-reason'], 'no_grant');
    assert.equal(answered.json().error, 'no_grant');
    assert.match(answered.json().message, /no grant for this hostname/i);
  });

  it('tells an expired grant apart from a workload nobody granted', async (t) => {
    let now = CONSTANTS.now;
    const gateway = await startTestGateway({
      probe: admitAll,
      resolve: echoGrant,
      handovers: [handoverFor({ expiresAt: CONSTANTS.now + 100 })],
      now: () => now,
    });
    t.after(() => gateway.close());

    const host = gateway.hostFor(WORKLOAD);
    assert.equal((await gateway.get(host)).status, 200);

    now = CONSTANTS.now + 101;
    const answered = await gateway.get(host);
    assert.equal(answered.status, 503);
    assert.equal(answered.headers['toon-gateway-reason'], 'grant_expired');
    assert.match(answered.json().message, /expired/i);

    // And it starts serving again the moment the tenant hands over a grant
    // derived for a later moment, with no restart: renewal is re-derivation
    // (spec §6.5.1).
    await gateway.handover(handoverFor({ expiresAt: CONSTANTS.now + 9999 }));
    await gateway.untilServed(host);
  });

  it('says a granted workload is not resolved yet, rather than saying nothing', async (t) => {
    // A resolver with a bug in it. The tenant is told a grant is held and
    // where the workload runs is not known — never a dropped connection, and
    // tellably different from a stopped workload.
    const gateway = await startTestGateway({
      probe: admitAll,
      handovers: [handoverFor()],
      resolve: async () => {
        throw new Error('a bug in the resolver');
      },
    });
    t.after(() => gateway.close());

    const answered = await gateway.get(gateway.hostFor(WORKLOAD));
    assert.equal(answered.status, 503);
    assert.equal(answered.headers['toon-gateway-reason'], 'not_resolved');
    assert.match(answered.json().message, new RegExp(WORKLOAD));
  });

  it('answers a browser a page it can read, and JSON to everything else', async (t) => {
    const gateway = await startTestGateway({ probe: admitAll });
    t.after(() => gateway.close());

    const host = gateway.hostFor(OTHER_WORKLOAD);
    const page = await gateway.get(host, { headers: { accept: 'text/html,*/*' } });
    assert.match(String(page.headers['content-type']), /text\/html/);
    assert.match(page.body, /no_grant/);

    const json = await gateway.get(host);
    assert.match(String(json.headers['content-type']), /application\/json/);
  });

  it('refuses a WebSocket upgrade to an ungranted hostname with the same reason', async (t) => {
    const gateway = await startTestGateway({ probe: admitAll });
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
      probe: admitAll,
      handovers: [handoverFor()],
      resolve: async (context) => {
        resolverCalls += 1;
        return echoGrant(context);
      },
    });
    t.after(() => gateway.close());

    // Let the workload this gateway DOES serve open everything it opens — its
    // members' Profiles and its Takeover watch — so that what is counted below
    // is only what the ungranted hostnames cost.
    await until(
      () => gateway.relay.requests.some((r) => r.filters.some((f) => f.kinds?.includes(K_TAKEOVER))),
      { what: 'the watches of the workload being served' },
    );
    const relayReads = gateway.relay.requests.length;

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
    assert.equal(gateway.relay.requests.length, relayReads, 'and no relay was read on its account');
  });
});
