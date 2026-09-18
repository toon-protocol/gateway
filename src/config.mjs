// What this gateway is configured with, and why it refuses to start.
//
// A half-configured gateway is worse than one that will not start: it answers
// a tenant's hostname with nothing, and nothing is exactly what a stopped
// workload and a broken gateway look like from outside (spec §12). So every
// missing or malformed key is collected and named in ONE refusal, rather than
// discovered one restart at a time.
//
// Environment only, like the provider's directory publisher: there is no
// config file to drift from what a deployment actually runs.

import { readFileSync } from 'node:fs';

import { validateSocks5hUrl } from '@toon-protocol/client';

import { ADMIT_PER_MINUTE } from './admit.mjs';
import { FOLLOW_TICK_MS } from './follow.mjs';
import { RESOLVE_TIMEOUT_MS } from './resolve.mjs';
import { readDialRewrites } from './rewrite.mjs';

const DEFAULT_HTTPS_PORT = 443;

/** A TCP port. `0` means "whatever the OS gives us", which is what tests use. */
const port = (value, key, problems) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    problems.push(`${key} is not a port: ${JSON.stringify(value)}`);
    return null;
  }
  return parsed;
};

/**
 * Read the configuration out of an environment, or throw naming everything
 * that is wrong with it.
 *
 * @param {Record<string, string | undefined>} env
 * @param {{ readFile?: (path: string) => string }} [io]
 */
export function readConfig(env, { readFile = (p) => readFileSync(p, 'utf8') } = {}) {
  /** @type {string[]} */
  const problems = [];

  /** A duration in milliseconds, or the default, or a named problem. */
  const millis = (key, fallback) => {
    if (env[key] === undefined) return fallback;
    const parsed = Number(env[key]);
    if (!Number.isInteger(parsed) || parsed < 1) {
      problems.push(`${key} is not a number of milliseconds: ${JSON.stringify(env[key])}`);
      return fallback;
    }
    return parsed;
  };

  const domain = env.GATEWAY_DOMAIN?.trim().toLowerCase().replace(/\.$/, '');
  if (!domain) {
    problems.push(
      'GATEWAY_DOMAIN is required: every workload is served at <canonical label>.<domain>.',
    );
  } else if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)) {
    problems.push(`GATEWAY_DOMAIN is not a domain name: ${JSON.stringify(env.GATEWAY_DOMAIN)}`);
  }

  const relays = (env.GATEWAY_RELAYS ?? '')
    .split(',')
    .map((relay) => relay.trim())
    .filter((relay) => relay !== '');
  if (relays.length === 0) {
    problems.push(
      'GATEWAY_RELAYS is required: it is where this gateway looks for the Provider Profiles of ' +
        'the members a handover names, and for the Takeovers that move a workload between them ' +
        '(spec §12.4, §12.7). Comma-separated `ws://` or `wss://` URLs.',
    );
  }
  for (const relay of relays) {
    if (!/^wss?:\/\/[^\s]+$/.test(relay)) {
      problems.push(`GATEWAY_RELAYS holds something that is not a relay URL: ${JSON.stringify(relay)}`);
    }
  }

  const httpsPort =
    env.GATEWAY_HTTPS_PORT === undefined
      ? DEFAULT_HTTPS_PORT
      : port(env.GATEWAY_HTTPS_PORT, 'GATEWAY_HTTPS_PORT', problems);
  const httpPort =
    env.GATEWAY_HTTP_PORT === undefined
      ? null
      : port(env.GATEWAY_HTTP_PORT, 'GATEWAY_HTTP_PORT', problems);

  // Where this gateway's connector forwards a sealed Gateway Handover (spec
  // §12.1). Its OWN port, never a path on the listeners that front workloads:
  // a reserved path would carve a hole out of every tenant's URL space, which
  // §12.5 forbids. A gateway without one can never be told anything, so it is
  // required rather than defaulted.
  let handoverPort = null;
  if (env.GATEWAY_HANDOVER_PORT === undefined) {
    problems.push(
      'GATEWAY_HANDOVER_PORT is required: it is where this gateway\'s connector forwards a ' +
        'sealed Gateway Handover (spec §12.1), and the only way a tenant can tell this gateway ' +
        'to serve a workload. It should not be reachable from outside the connector.',
    );
  } else {
    handoverPort = port(env.GATEWAY_HANDOVER_PORT, 'GATEWAY_HANDOVER_PORT', problems);
  }

  // TLS for this gateway's OWN domain, so a workload is reachable over HTTPS
  // while holding no certificate itself and no provider ever touches a
  // tenant's certificate key (ADR 0013).
  const certPath = env.GATEWAY_TLS_CERT;
  const keyPath = env.GATEWAY_TLS_KEY;
  let tls = null;
  if (certPath !== undefined || keyPath !== undefined) {
    if (certPath === undefined) problems.push('GATEWAY_TLS_CERT is required beside GATEWAY_TLS_KEY');
    if (keyPath === undefined) problems.push('GATEWAY_TLS_KEY is required beside GATEWAY_TLS_CERT');
    if (certPath !== undefined && keyPath !== undefined) {
      try {
        tls = { cert: readFile(certPath), key: readFile(keyPath) };
      } catch (e) {
        problems.push(
          `the TLS certificate or key could not be read: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  } else if (httpPort === null) {
    problems.push(
      'this gateway has nothing to front a workload on: set GATEWAY_TLS_CERT and GATEWAY_TLS_KEY to ' +
        'terminate TLS for GATEWAY_DOMAIN, or GATEWAY_HTTP_PORT for a plain-HTTP listener in ' +
        'development.',
    );
  }

  // How long resolution waits for anything it needs: a member's Provider
  // Profile off a relay, and that member's answer to `status`. It bounds a
  // tenant's wait, because every member is asked at once — one slow member
  // costs this and no more.
  const resolveTimeoutMs = millis('GATEWAY_RESOLVE_TIMEOUT_MS', RESOLVE_TIMEOUT_MS);

  // How often the gateway looks at the clock while following a workload (spec
  // §12.7). It decides NOTHING: a settle window and a Liveness cadence are
  // counted in the grant's and the Profile's own seconds, and this is only how
  // late this process may be in noticing that one has passed.
  const followTickMs = millis('GATEWAY_FOLLOW_TICK_MS', FOLLOW_TICK_MS);

  // How many admission rounds one Standby Set member may be asked for in a
  // minute (spec §12.1). Anyone can seal a handover naming any provider, so
  // one sealed packet buys one free `status` per member it names; this is what
  // stops a burst of unsolicited handovers making a reflector of this gateway.
  let admitPerMinute = ADMIT_PER_MINUTE;
  if (env.GATEWAY_ADMIT_PER_MINUTE !== undefined) {
    const parsed = Number(env.GATEWAY_ADMIT_PER_MINUTE);
    if (!Number.isInteger(parsed) || parsed < 1) {
      problems.push(
        `GATEWAY_ADMIT_PER_MINUTE is not a number of admissions per minute: ${JSON.stringify(env.GATEWAY_ADMIT_PER_MINUTE)}`,
      );
    } else {
      admitPerMinute = parsed;
    }
  }

  // The anon client every `.anyone` host is dialled through (`src/dial.mjs`).
  // Validated here so a deployment that meant to front a Hidden Provider's
  // workload finds out at startup, not at the first request that needs it.
  let socksProxy;
  if (env.TOON_SOCKS_PROXY !== undefined && env.TOON_SOCKS_PROXY !== '') {
    try {
      validateSocks5hUrl(env.TOON_SOCKS_PROXY);
      const parsed = new URL(env.TOON_SOCKS_PROXY.replace(/^socks5h:\/\//, 'http://'));
      if (parsed.hostname === '' || parsed.port === '') {
        throw new Error(
          `a SOCKS5 proxy must name both a host and a port: ${JSON.stringify(env.TOON_SOCKS_PROXY)}`,
        );
      }
      socksProxy = env.TOON_SOCKS_PROXY;
    } catch (e) {
      problems.push(`TOON_SOCKS_PROXY: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Where an advertised address is dialled instead (`src/rewrite.mjs`): a
  // development sandbox's compose names and host loopback. Empty in
  // production, where what a member advertises is where it is.
  let dialRewrites = new Map();
  if (env.GATEWAY_DIAL_REWRITE !== undefined && env.GATEWAY_DIAL_REWRITE.trim() !== '') {
    try {
      dialRewrites = readDialRewrites(env.GATEWAY_DIAL_REWRITE);
    } catch (e) {
      problems.push(e instanceof Error ? e.message : String(e));
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `this Workload Gateway cannot start:\n${problems.map((p) => `  - ${p}`).join('\n')}`,
    );
  }

  return {
    domain: /** @type {string} */ (domain),
    relays,
    bindAddress: env.GATEWAY_BIND_ADDR ?? '0.0.0.0',
    httpsPort: tls === null ? null : httpsPort,
    httpPort,
    /** Where the connector forwards a sealed Gateway Handover (spec §12.1). */
    handoverPort: /** @type {number} */ (handoverPort),
    tls,
    socksProxy,
    resolveTimeoutMs,
    followTickMs,
    admitPerMinute,
    dialRewrites,
  };
}
