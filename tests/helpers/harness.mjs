// The harness: a Workload Gateway running in this process, driven at its own
// listening ports, against a stub relay, stub provider connectors and stub
// workloads.
//
// TWO seams, and they are the two a tenant has. A handover — or a withdrawal
// (spec §12.7) — is POSTed at the gateway's HANDOVER port, which is where its
// connector forwards a sealed packet (spec §12.1); a request for a workload
// goes to its HTTP (or HTTPS) port. A test drives those two, publishes the Provider Profiles and Takeovers
// a gateway reads into the stub relay, and asserts on what the gateway
// ANSWERED and what reached the stubs. Nothing asserts on what the gateway
// holds internally: a test written that way passes when the gateway is broken
// in exactly the way that matters.
//
// `probe` is the admission round (`src/admit.mjs`). A test that is about
// something downstream of admission passes `admitAll` and gets a handover
// admitted without a round, exactly as one that is about something downstream
// of resolution passes its own `resolve`. `tests/admission.test.mjs` is where
// the real round is driven.

import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { readFileSync } from 'node:fs';

import { readConfig } from '../../src/config.mjs';
import { startGateway } from '../../src/gateway.mjs';
import { HANDOVER_PATH } from '../../src/handover.mjs';
import { canonicalLabel } from '../../src/hostname.mjs';
import { CONSTANTS } from './events.mjs';
import { startStubRelay } from './stub-relay.mjs';

export const TLS = {
  certPath: new URL('../fixtures/tls/gw.test.cert.pem', import.meta.url).pathname,
  keyPath: new URL('../fixtures/tls/gw.test.key.pem', import.meta.url).pathname,
};

export const DOMAIN = 'gw.test';

/**
 * An admission round that accepts anything, for a test about what happens
 * AFTER a workload is being served. It asks no member and finds no target.
 */
export const admitAll = async () => ({ told: 1 });

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
 * - `resolve` is the resolver seam M5-4 fills in; `probe` is the admission
 *   seam M6-4 fills in (`admitAll` above).
 * - `handovers` are sealed handovers delivered before the test body runs, each
 *   POSTed at the handover port exactly as the connector would forward it.
 *   Every one of them must be admitted, or starting fails saying which.
 * - `now` is the gateway's clock. It defaults to the fixture clock
 *   (`CONSTANTS.now`), the fixed world every wire fixture was generated in, so
 *   a grant's `expires_at` means the same thing in a test today as it did when
 *   the fixtures were made. Pass a mutable one to move time.
 *
 * @param {{
 *   events?: object[], handovers?: object[], relays?: string[], domain?: string,
 *   tls?: boolean, http?: boolean, resolve?: import('../../src/serve.mjs').Resolver,
 *   probe?: (handover: any) => Promise<{ told: number, target?: any }>,
 *   now?: () => number, env?: Record<string, string>, log?: (line: string) => void,
 * }} [options]
 */
export async function startTestGateway({
  events = [],
  handovers = [],
  relays = [],
  domain = DOMAIN,
  tls = false,
  http = true,
  resolve,
  probe,
  now = () => CONSTANTS.now,
  env = {},
  log,
} = {}) {
  const lines = [];
  const relay = await startStubRelay({ events });
  let config;
  try {
    config = readConfig({
      GATEWAY_DOMAIN: domain,
      GATEWAY_RELAYS: [relay.url, ...relays].join(','),
      GATEWAY_BIND_ADDR: '127.0.0.1',
      GATEWAY_HANDOVER_PORT: '0',
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
    probe,
    now,
    log: log ?? ((line) => lines.push(line)),
  });

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

    /**
     * Seal a Gateway Handover to this gateway, as its connector forwards one.
     *
     * Plain HTTP because the connector has already unsealed the envelope: what
     * the gateway app reads is plaintext JSON at its handover port (§12.1).
     */
    handover: (body, { path = HANDOVER_PATH, method = 'POST' } = {}) =>
      requestGateway({
        port: gateway.handoverPort,
        host: `127.0.0.1:${gateway.handoverPort}`,
        path,
        method,
        headers: { 'content-type': 'application/json' },
        // A GET carrying a body is a malformed request Node's own server
        // refuses before this gateway sees it, so the probe for "anything but
        // a POST" sends none.
        body: method === 'GET' ? undefined : JSON.stringify(body),
      }),

    /**
     * Seal a Gateway Withdrawal to this gateway (spec §12.7).
     *
     * The SAME door a handover arrives at, because a tenant seals both to the
     * one route this gateway's connector terminates: what says which message
     * it is is the body's one key, and nothing else.
     */
    withdraw: (body, options = {}) => harness.handover(body, options),

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

  for (const body of handovers) {
    const answered = await harness.handover(body);
    if (answered.status !== 200) {
      await harness.close();
      throw new Error(`the handover this test starts with was refused: ${answered.body}`);
    }
  }

  return harness;
}

export const readTestCert = () => readFileSync(TLS.certPath, 'utf8');
