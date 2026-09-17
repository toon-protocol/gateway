// The harness: a Workload Gateway running in this process, driven at its own
// listening port, against a stub relay, stub provider connectors and stub
// workloads.
//
// ONE seam: the gateway's HTTP (or HTTPS) port. A test publishes events into
// the stub relay, sends requests at the gateway's port, and asserts on what
// the gateway ANSWERED and what reached the stubs. Nothing asserts on what
// the gateway holds internally: a test written that way passes when the
// gateway is broken in exactly the way that matters.
//
// Every later Milestone 5 gateway test uses this:
//   M5-4 — a stub connector per Standby Set member and a stub workload behind
//          the running one; assert on `workload.requests[0].headers`.
//   M5-5 — `relay.publish(takeover({...}))` mid-test; assert that forwarding
//          moved, and not before the settle window.
//   M5-6 — a stub SOCKS proxy (`stub-socks.mjs`) routing `.anyone` names to
//          the stubs; assert every such connection went through it and
//          nothing came any other way (`hidden.test.mjs`).

import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { readFileSync } from 'node:fs';

import { readConfig } from '../../src/config.mjs';
import { startGateway } from '../../src/gateway.mjs';
import { canonicalLabel } from '../../src/hostname.mjs';
import { CONSTANTS } from './events.mjs';
import { startStubRelay } from './stub-relay.mjs';

export const TLS = {
  certPath: new URL('../fixtures/tls/gw.test.cert.pem', import.meta.url).pathname,
  keyPath: new URL('../fixtures/tls/gw.test.key.pem', import.meta.url).pathname,
};

export const DOMAIN = 'gw.test';
export const GATEWAY_KEY = CONSTANTS.gateway;

/** Wait until `check()` returns something truthy, or fail loudly. */
/**
 * @param {() => any} check
 * @param {{ timeoutMs?: number, everyMs?: number, what?: string }} [options]
 */
export async function until(check, { timeoutMs = 4000, everyMs = 10, what = 'a condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
}

/**
 * One request at the gateway's own port, with the `Host` a tenant would send.
 *
 * `node:http` rather than `fetch`, because the whole point is to control the
 * Host header and to see the raw status, headers and body the gateway wrote.
 */
/**
 * @param {{
 *   port: number, host: string, path?: string, method?: string,
 *   headers?: Record<string, string>, body?: string, tls?: boolean, timeoutMs?: number,
 * }} options
 * @returns {Promise<{ status: number | undefined, headers: Record<string, any>, body: string, json: () => any }>}
 */
export function requestGateway({ port, host, path = '/', method = 'GET', headers = {}, body, tls = false, timeoutMs = 4000 }) {
  const send = tls ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = send(
      {
        host: '127.0.0.1',
        port,
        path,
        method,
        headers: { host, ...headers },
        ...(tls ? { servername: host.split(':')[0], rejectUnauthorized: false } : {}),
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
            json: () => JSON.parse(Buffer.concat(chunks).toString('utf8')),
          }),
        );
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error('the gateway did not answer')));
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/**
 * Start a gateway wired to a stub relay.
 *
 * - `events` are what the relay already holds at startup.
 * - `relays` are extra relay URLs beside the stub one.
 * - `tls` terminates TLS with the test certificate; `http` (default) runs the
 *   plain development listener.
 * - `resolve` is the resolver seam M5-4 fills in.
 * - `now` is the gateway's clock. It defaults to the fixture clock
 *   (`CONSTANTS.now`), the fixed world every wire fixture was generated in, so
 *   a grant's `expires_at` means the same thing in a test today as it did when
 *   the fixtures were made. Pass a mutable one to move time.
 *
 * @param {{
 *   events?: object[], relays?: string[], domain?: string, tls?: boolean,
 *   http?: boolean, resolve?: import('../../src/serve.mjs').Resolver, now?: () => number,
 *   env?: Record<string, string>, log?: (line: string) => void,
 * }} [options]
 */
export async function startTestGateway({
  events = [],
  relays = [],
  domain = DOMAIN,
  tls = false,
  http = true,
  resolve,
  now = () => CONSTANTS.now,
  env = {},
  log,
} = {}) {
  const lines = [];
  const relay = await startStubRelay({ events });
  let config;
  try {
    config = readConfig({
      GATEWAY_SECRET_KEY: GATEWAY_KEY.secret_key,
      GATEWAY_DOMAIN: domain,
      GATEWAY_RELAYS: [relay.url, ...relays].join(','),
      GATEWAY_BIND_ADDR: '127.0.0.1',
      ...(http ? { GATEWAY_HTTP_PORT: '0' } : {}),
      ...(tls ? { GATEWAY_TLS_CERT: TLS.certPath, GATEWAY_TLS_KEY: TLS.keyPath, GATEWAY_HTTPS_PORT: '0' } : {}),
      ...env,
    });
  } catch (e) {
    await relay.close();
    throw e;
  }

  const gateway = await startGateway({
    config,
    resolve,
    now,
    log: log ?? ((line) => lines.push(line)),
  });
  await gateway.caughtUp();

  const secure = gateway.httpPort === null;

  const harness = {
    relay,
    gateway,
    config,
    domain,
    /** Everything the gateway logged, for asserting that it SAID why. */
    log: lines,
    httpPort: gateway.httpPort,
    httpsPort: gateway.httpsPort,
    /** `<canonical label>.<domain>` for a workload id. */
    hostFor: (workloadId) => `${canonicalLabel(workloadId)}.${domain}`,

    /** One request at the gateway, at a hostname. */
    get(host, options = {}) {
      const overTls = options.tls ?? secure;
      return requestGateway({
        ...options,
        port: overTls ? gateway.httpsPort : gateway.httpPort,
        host,
        tls: overTls,
      });
    },

    /** Publish into the relay the gateway is watching, mid-test. */
    publish: (event) => relay.publish(event),

    /** Wait until the gateway answers a hostname with something other than 503. */
    untilServed: (host) => until(async () => (await harness.get(host)).status !== 503, { what: `${host} to be served` }),

    /** Wait until the gateway answers a hostname with this reason. */
    untilReason: (host, reason) =>
      until(async () => (await harness.get(host)).headers['toon-gateway-reason'] === reason, {
        what: `${host} to answer ${reason}`,
      }),

    async close() {
      await gateway.stop();
      await relay.close();
    },
  };

  return harness;
}

export const readTestCert = () => readFileSync(TLS.certPath, 'utf8');
