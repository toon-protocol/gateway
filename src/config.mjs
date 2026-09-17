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

import { publicKeyOf } from './nostr.mjs';
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

  const secretKey = env.GATEWAY_SECRET_KEY;
  let publicKey = null;
  if (!secretKey) {
    problems.push(
      'GATEWAY_SECRET_KEY is required: it is this gateway\'s Nostr identity — the key a ' +
        'tenant names in a Gateway Grant (spec §3.1.3) and the key it signs `status` with (§6.5).',
    );
  } else {
    try {
      publicKey = publicKeyOf(secretKey);
    } catch {
      problems.push(
        'GATEWAY_SECRET_KEY must be a 32-byte Nostr secret key as 64 hex characters ' +
          '(an `nsec…` is not accepted; decode it first).',
      );
    }
  }

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
      'GATEWAY_RELAYS is required: it is where this gateway watches for the Gateway Grants ' +
        'that name it (spec §3.1.3). Comma-separated `ws://` or `wss://` URLs.',
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
      'this gateway has nothing to listen on: set GATEWAY_TLS_CERT and GATEWAY_TLS_KEY to ' +
        'terminate TLS for GATEWAY_DOMAIN, or GATEWAY_HTTP_PORT for a plain-HTTP listener in ' +
        'development.',
    );
  }

  // How long resolution waits for anything it needs: a member's Provider
  // Profile off a relay, and that member's answer to `status`. It bounds a
  // tenant's wait, because every member is asked at once — one slow member
  // costs this and no more.
  let resolveTimeoutMs = RESOLVE_TIMEOUT_MS;
  if (env.GATEWAY_RESOLVE_TIMEOUT_MS !== undefined) {
    const parsed = Number(env.GATEWAY_RESOLVE_TIMEOUT_MS);
    if (!Number.isInteger(parsed) || parsed < 1) {
      problems.push(
        'GATEWAY_RESOLVE_TIMEOUT_MS is not a number of milliseconds: ' +
          JSON.stringify(env.GATEWAY_RESOLVE_TIMEOUT_MS),
      );
    } else {
      resolveTimeoutMs = parsed;
    }
  }

  // The proxy for `.anyone` hosts. Validated here so a deployment that meant
  // to hide finds out at startup; M5-6 is what dials through it.
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
    /** The key this gateway is named by in a grant, and signs `status` with. */
    publicKey: /** @type {string} */ (publicKey),
    /** A call, not a field: a secret key that is never in a log line or a dump. */
    secretKey: () => /** @type {string} */ (secretKey),
    domain: /** @type {string} */ (domain),
    relays,
    bindAddress: env.GATEWAY_BIND_ADDR ?? '0.0.0.0',
    httpsPort: tls === null ? null : httpsPort,
    httpPort,
    tls,
    socksProxy,
    resolveTimeoutMs,
    dialRewrites,
  };
}
