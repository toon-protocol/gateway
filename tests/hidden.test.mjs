// A workload on a Hidden Provider, reached through the gateway's anon client
// (spec §10, §12.8).
//
// Driven at the gateway's own listening port, with a stub SOCKS proxy standing
// in for the `anon` daemon. What is asserted is what was dialled THROUGH the
// proxy and what was not: the proxy alone knows where an `.anyone` name really
// is, so a gateway that resolved or dialled one directly reaches nothing —
// and every stub also records who connected to it, so "it went through the
// proxy" is a positive fact and not the absence of a failure.

import { strict as assert } from 'node:assert';
import dns from 'node:dns';
import { describe, it } from 'node:test';
import WebSocket from 'ws';

import { isAnyoneHost } from '../src/dial.mjs';
import { CONSTANTS, providerProfile } from './helpers/events.mjs';
import { gatewayHandover } from './helpers/handover.mjs';
import { admitAll, startTestGateway, until } from './helpers/harness.mjs';
import { running, startStubConnector } from './helpers/stub-connector.mjs';
import { startStubSocks } from './helpers/stub-socks.mjs';
import { startStubWorkload } from './helpers/stub-workload.mjs';

const WORKLOAD = 'bb'.repeat(32);
const HTTP_PORT = 8080;

/** The shapes a real Hidden Provider publishes: 56 base32 characters, then `.anyone`. */
const CONNECTOR_NAME = `${'hiddenfixture'.repeat(4)}hidd.anyone`;
const LEASE_NAME = `${'k'.repeat(56)}.anyone`;
const HIDDEN_RELAY = `${'r'.repeat(56)}.anyone`;

const PUBLIC = CONSTANTS.primary_provider;
const HIDDEN = CONSTANTS.standby_provider;

/**
 * Watch the system resolver for the one thing it must never be asked.
 *
 * `net.connect` resolves through `dns.lookup`, so a gateway that handed an
 * `.anyone` name to `getaddrinfo` shows up here — before the dial fails, and
 * whether or not it fails.
 */
const watchResolver = (t) => {
  /** @type {string[]} */
  const leaked = [];
  const original = dns.lookup;
  dns.lookup = /** @type {any} */ (
    function lookup(hostname, ...rest) {
      if (isAnyoneHost(hostname)) leaked.push(hostname);
      return original.call(this, hostname, ...rest);
    }
  );
  t.after(() => {
    dns.lookup = original;
  });
  return leaked;
};

/** A member that answers `reserved`: a Warm Standby doing its job. */
const reserved = ({ workloadId }) => ({
  workload_id: workloadId,
  role: 'standby',
  state: 'reserved',
  expires_at: CONSTANTS.now + 3600,
});

/** The answer of a member running the workload at `host`, published on `port`. */
const runningAt = (host, port) => ({ workloadId }) =>
  running({ workloadId, host, ports: [{ container_port: HTTP_PORT, host_port: port }] });

/**
 * One Standby Set member: a stub connector, and a stub workload behind it.
 *
 * Public, the connector is at a loopback address and its Profile says so.
 * Hidden, the connector is reachable only as `CONNECTOR_NAME` and the
 * workload only as `LEASE_NAME`, both routed by the proxy alone — so the
 * member's `routes` are what a stub proxy is started with.
 *
 * @param {import('node:test').TestContext} t
 * @param {{ hidden: boolean, answer?: (context: any) => object, body?: string, relays?: string[] }} options
 *   `answer` is what the connector answers `status` with; left out, the
 *   member is running the workload.
 */
async function member(t, { hidden, answer, body, relays = [] }) {
  const key = hidden ? HIDDEN : PUBLIC;
  const workload = await startStubWorkload({
    body: body ?? (hidden ? 'from behind the anon client' : 'from the public member'),
  });
  const connector = await startStubConnector({
    pubkey: key.public_key,
    answer: answer ?? runningAt(hidden ? LEASE_NAME : workload.host, workload.port),
  });
  t.after(() => connector.close());
  t.after(() => workload.close());
  return {
    workload,
    connector,
    profile: providerProfile({
      providerSecret: key.secret_key,
      connectorUrl: hidden ? `http://${CONNECTOR_NAME}/ilp` : connector.url,
      hidden,
      relays,
    }),
    routes: hidden
      ? {
          [CONNECTOR_NAME]: { host: connector.host, port: connector.port },
          [LEASE_NAME]: { host: workload.host, port: workload.port },
        }
      : {},
  };
}

const handoverFor = (standbySet) =>
  gatewayHandover({ workloadId: WORKLOAD, httpPort: HTTP_PORT, standbySet });

/** Everything that reached a stub came in through `proxy`, and nothing came in any other way. */
const cameThroughProxy = (proxy, records, what) => {
  assert.ok(records.length > 0, `nothing reached ${what}`);
  for (const record of records) {
    assert.ok(proxy.opened(record.peer), `${what} was reached from ${record.peer.address}:${record.peer.port}, not through the proxy`);
  }
};

describe('a workload on a Hidden Provider', () => {
  it('asks a member at an `.anyone` connector for `status` through the proxy, and the answer resolves the workload as a public member\'s does', async (t) => {
    const leaked = watchResolver(t);
    // A Hidden Provider's own Relay Set is behind anon too (ADR 0008). Its
    // Profile still has to be findable — here, on the relay the gateway is
    // configured with — and that relay's name must go nowhere either.
    const hidden = await member(t, { hidden: true, relays: [`wss://${HIDDEN_RELAY}`] });
    const proxy = await startStubSocks({ routes: hidden.routes });
    t.after(() => proxy.close());

    const gateway = await startTestGateway({
      events: [hidden.profile], handovers: [handoverFor([HIDDEN.public_key])], probe: admitAll,
      env: { TOON_SOCKS_PROXY: proxy.url },
    });
    t.after(() => gateway.close());

    const host = gateway.hostFor(WORKLOAD);
    const answered = await gateway.get(host, { path: '/orders?page=2' });
    assert.equal(answered.status, 200, answered.body);
    assert.equal(answered.body, 'from behind the anon client');

    // `status` reached the connector by its NAME, through the proxy, and was
    // the same request a public member gets: unsigned, presenting the grant.
    assert.ok(proxy.askedFor(CONNECTOR_NAME, 80), `the proxy was asked for ${CONNECTOR_NAME}:80; it saw ${JSON.stringify(proxy.destinations)}`);
    const [asked] = hidden.connector.requests;
    assert.equal(asked.path, '/status');
    assert.equal(asked.request.sig, undefined, 'nobody signs a Lease Request');
    assert.equal(asked.content.workload_id, WORKLOAD);
    assert.ok(asked.continuation !== undefined, 'presenting the grant');
    cameThroughProxy(proxy, hidden.connector.requests, 'the hidden connector');

    // And the answer's `.anyone` access host was forwarded to through the
    // same proxy, with the usual forwarding headers.
    assert.ok(proxy.askedFor(LEASE_NAME, hidden.workload.port), `the proxy was asked for the lease address; it saw ${JSON.stringify(proxy.destinations)}`);
    const [reached] = hidden.workload.requests;
    assert.equal(reached.url, '/orders?page=2');
    assert.equal(reached.headers.host, host, 'the application sees the name the tenant used');
    assert.equal(reached.headers['x-forwarded-host'], host);
    assert.equal(reached.headers['x-forwarded-proto'], 'http');
    assert.equal(reached.headers['x-forwarded-for'], '127.0.0.1');
    cameThroughProxy(proxy, hidden.workload.requests, 'the hidden workload');

    // The names went to the proxy as NAMES: the gateway resolved nothing.
    for (const destination of proxy.destinations) {
      assert.equal(destination.type, 'domain', `${destination.host} was handed to the proxy already resolved`);
    }
    assert.deepEqual(leaked, [], 'no `.anyone` name reached the system resolver');

    // The member's `.anyone` relay was neither dialled nor quietly dropped.
    assert.ok(!proxy.askedFor(HIDDEN_RELAY, 443), 'a relay is not reached through the proxy either');
    assert.ok(
      gateway.log.some((line) => line.includes(HIDDEN_RELAY) && /not watched/.test(line)),
      `the gateway said it is not watching ${HIDDEN_RELAY}; it logged ${JSON.stringify(gateway.log)}`,
    );
  });

  it('reaches an `.anyone` name only through the proxy: one the proxy cannot reach is unreachable, not dialled directly', async (t) => {
    const leaked = watchResolver(t);
    const hidden = await member(t, { hidden: true });
    // A proxy with no route to the connector: what an `anon` daemon that can
    // build no circuit to a hidden service answers. The connector IS running,
    // on this host, and a gateway that dialled it any other way would find it.
    const proxy = await startStubSocks({ routes: {} });
    t.after(() => proxy.close());

    const gateway = await startTestGateway({
      events: [hidden.profile], handovers: [handoverFor([HIDDEN.public_key])], probe: admitAll,
      env: { TOON_SOCKS_PROXY: proxy.url },
    });
    t.after(() => gateway.close());

    const answered = await gateway.get(gateway.hostFor(WORKLOAD));
    assert.equal(answered.status, 503);
    assert.equal(answered.headers['toon-gateway-reason'], 'member_unreachable');
    assert.ok(proxy.askedFor(CONNECTOR_NAME, 80), 'the proxy was the one asked');
    assert.equal(hidden.connector.requests.length, 0, 'and nothing reached the connector any other way');
    assert.deepEqual(leaked, [], 'no `.anyone` name reached the system resolver');
  });

  it('dials a public member directly, so a Standby Set mixing a public primary and a hidden standby needs no extra configuration', async (t) => {
    const leaked = watchResolver(t);
    // The public primary is `reserved` — it has lost the workload to the
    // hidden standby, say — so the request must end up behind the proxy.
    const pub = await member(t, { hidden: false, answer: reserved });
    const hidden = await member(t, { hidden: true });
    const proxy = await startStubSocks({ routes: hidden.routes });
    t.after(() => proxy.close());

    const gateway = await startTestGateway({
      events: [pub.profile, hidden.profile], handovers: [handoverFor([PUBLIC.public_key, HIDDEN.public_key])], probe: admitAll,
      env: { TOON_SOCKS_PROXY: proxy.url },
    });
    t.after(() => gateway.close());

    const answered = await gateway.get(gateway.hostFor(WORKLOAD));
    assert.equal(answered.status, 200, answered.body);
    assert.equal(answered.body, 'from behind the anon client');

    // Both members were asked — the public one directly, the hidden one
    // through the proxy — and only the `.anyone` names went to the proxy.
    assert.equal(pub.connector.requests.length, 1, 'the public member was asked');
    assert.ok(!proxy.opened(pub.connector.requests[0].peer), 'and directly, not through the proxy');
    assert.equal(pub.workload.requests.length, 0, 'a reserved member gets no traffic');
    cameThroughProxy(proxy, hidden.connector.requests, 'the hidden connector');
    cameThroughProxy(proxy, hidden.workload.requests, 'the hidden workload');
    assert.ok(proxy.destinations.every((d) => isAnyoneHost(d.host)), `only .anyone names go to the proxy; it saw ${JSON.stringify(proxy.destinations)}`);
    assert.deepEqual(leaked, []);
  });

  it('forwards to a public primary directly while a hidden standby waits, on the same configuration', async (t) => {
    const leaked = watchResolver(t);
    const pub = await member(t, { hidden: false });
    const hidden = await member(t, { hidden: true, answer: reserved });
    const proxy = await startStubSocks({ routes: hidden.routes });
    t.after(() => proxy.close());

    const gateway = await startTestGateway({
      events: [pub.profile, hidden.profile], handovers: [handoverFor([PUBLIC.public_key, HIDDEN.public_key])], probe: admitAll,
      env: { TOON_SOCKS_PROXY: proxy.url },
    });
    t.after(() => gateway.close());

    const answered = await gateway.get(gateway.hostFor(WORKLOAD));
    assert.equal(answered.status, 200, answered.body);
    assert.equal(answered.body, 'from the public member');

    assert.equal(pub.workload.requests.length, 1);
    assert.ok(!proxy.opened(pub.workload.requests[0].peer), 'the public workload was reached directly');
    assert.ok(proxy.askedFor(CONNECTOR_NAME, 80), 'the hidden standby was still asked, through the proxy');
    assert.ok(!proxy.askedFor(LEASE_NAME, hidden.workload.port), 'and nothing was forwarded to it');
    assert.deepEqual(leaked, []);
  });

  it('answers `no_proxy` for a member at an `.anyone` connector when no proxy is configured, and asks nobody', async (t) => {
    const leaked = watchResolver(t);
    const hidden = await member(t, { hidden: true });

    const gateway = await startTestGateway({ events: [hidden.profile], handovers: [handoverFor([HIDDEN.public_key])], probe: admitAll });
    t.after(() => gateway.close());

    const answered = await gateway.get(gateway.hostFor(WORKLOAD));
    assert.equal(answered.status, 503);
    assert.equal(answered.headers['toon-gateway-reason'], 'no_proxy');
    const body = answered.json();
    assert.equal(body.error, 'no_proxy');
    assert.match(body.message, /TOON_SOCKS_PROXY/, 'names what is missing');
    assert.match(body.message, new RegExp(CONNECTOR_NAME), 'and the address that needed it');
    assert.equal(hidden.connector.requests.length, 0, 'the connector was never reached');
    assert.deepEqual(leaked, [], 'and its name never reached the system resolver');
  });

  it('answers `no_proxy` when a public member answers an `.anyone` access host and no proxy is configured', async (t) => {
    const leaked = watchResolver(t);
    // A public connector whose lease is at a hidden address: the `status` leg
    // is fine, and the forwarding leg is the one that needs the proxy.
    const pub = await member(t, { hidden: false, answer: runningAt(LEASE_NAME, 8081) });

    const gateway = await startTestGateway({ events: [pub.profile], handovers: [handoverFor([PUBLIC.public_key])], probe: admitAll });
    t.after(() => gateway.close());

    const answered = await gateway.get(gateway.hostFor(WORKLOAD));
    assert.equal(answered.status, 503);
    assert.equal(answered.headers['toon-gateway-reason'], 'no_proxy');
    assert.match(answered.json().message, new RegExp(`${LEASE_NAME}:8081`));
    assert.equal(pub.connector.requests.length, 1, 'the public connector was asked, directly');
    assert.deepEqual(leaked, [], 'the lease address never reached the system resolver');
  });

  it('passes a WebSocket upgrade through the proxy too', async (t) => {
    const leaked = watchResolver(t);
    const hidden = await member(t, { hidden: true });
    const proxy = await startStubSocks({ routes: hidden.routes });
    t.after(() => proxy.close());

    const gateway = await startTestGateway({
      events: [hidden.profile], handovers: [handoverFor([HIDDEN.public_key])], probe: admitAll,
      env: { TOON_SOCKS_PROXY: proxy.url },
    });
    t.after(() => gateway.close());

    const host = gateway.hostFor(WORKLOAD);
    const socket = new WebSocket(`ws://127.0.0.1:${gateway.httpPort}/live`, { headers: { host } });
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

    assert.deepEqual(heard, ['echo:from the tenant']);
    cameThroughProxy(proxy, hidden.workload.upgrades, 'the hidden workload\'s WebSocket');
    assert.deepEqual(leaked, []);
  });
});
