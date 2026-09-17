// Where this gateway dials, when where a member SAYS it is differs from where
// this gateway can reach it.
//
// A gateway dials two kinds of address it did not choose: a member's
// `connector_url`, out of its Profile (spec §4.1), and the `access.host` the
// running member answered (§6.5) — and both name the member as ITS OWN clients
// reach it. In a deployment those are the addresses. In a development sandbox
// they are not: a provider on a compose network advertises
// `provider-connector:3000`, which is a connector that terminates only sealed
// packets (`src/status.mjs` says why that matters), and publishes its
// workloads on the host's `127.0.0.1`, which from inside this process's own
// container is this process. Its free `status` route is served plainly by the
// provider app at another name, and the host is reachable at another name
// again; nothing about the protocol changes, only where the socket goes.
//
// `GATEWAY_DIAL_REWRITE` is a JSON map from an advertised `host` or
// `host:port` to the `host` or `host:port` this gateway dials instead. It is
// applied at the ONE seam every outbound connection goes through
// (`src/dial.mjs`), so the `status` leg and the forwarding leg cannot disagree
// about it, and it is the counterpart of the directory publisher's
// `TOON_ENDPOINT_REWRITE`: sandbox-only, because in production the advertised
// address is the real one.
//
// What it does NOT do: it rewrites no URL, no `Host` header and nothing a
// member or a workload sees. The request is what §6.5 fixes; only the socket
// moves.

import { connect as netConnect } from 'node:net';

/**
 * One side of a rewrite: `host` or `host:port`, an IPv6 host in brackets.
 *
 * @returns {{ host: string, port: number | undefined }}
 */
function endpoint(text, what) {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new Error(`${what} must be a host or host:port, not ${JSON.stringify(text)}`);
  }
  const value = text.trim();
  const match = value.match(/^(\[[^\]]+\]|[^:]+)(?::(\d{1,5}))?$/);
  if (match === null) throw new Error(`${what} is not a host or host:port: ${JSON.stringify(text)}`);
  const host = match[1].replace(/^\[|\]$/g, '').toLowerCase();
  const port = match[2] === undefined ? undefined : Number(match[2]);
  if (port !== undefined && (port < 1 || port > 65535)) {
    throw new Error(`${what} names a port that is not one: ${JSON.stringify(text)}`);
  }
  return { host, port };
}

/**
 * Read `GATEWAY_DIAL_REWRITE`, or throw saying what is wrong with it.
 *
 * @param {string} text  the environment value, a JSON object
 * @returns {Map<string, { host: string, port: number | undefined }>}
 *   keyed by `host` or `host:port`, lowercase
 */
export function readDialRewrites(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('GATEWAY_DIAL_REWRITE is not JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('GATEWAY_DIAL_REWRITE must be a JSON object of "host[:port]": "host[:port]"');
  }
  const rewrites = new Map();
  for (const [from, to] of Object.entries(parsed)) {
    const source = endpoint(from, `GATEWAY_DIAL_REWRITE key ${JSON.stringify(from)}`);
    const target = endpoint(to, `GATEWAY_DIAL_REWRITE value for ${JSON.stringify(from)}`);
    rewrites.set(source.port === undefined ? source.host : `${source.host}:${source.port}`, target);
  }
  return rewrites;
}

/**
 * Where `host:port` is actually dialled: the exact `host:port` entry if there
 * is one, else the bare `host` entry, else itself. A target with no port keeps
 * the port that was asked for.
 *
 * @param {Map<string, { host: string, port: number | undefined }>} rewrites
 * @returns {{ host: string, port: number }}
 */
export function rewriteTarget(rewrites, host, port) {
  const key = String(host).replace(/^\[|\]$/g, '').toLowerCase();
  const to = rewrites.get(`${key}:${port}`) ?? rewrites.get(key);
  if (to === undefined) return { host, port };
  return { host: to.host, port: to.port ?? port };
}

/**
 * The dialler with the rewrites in front of it.
 *
 * A rewritten target is handed to the underlying dialler as if it had been
 * asked for in the first place — so a rewrite ONTO an `.anyone` name still
 * goes through the proxy, and a rewrite off one deliberately does not. When
 * the dialler answers "an ordinary direct dial", the direct dial is made here
 * to the rewritten target, because the caller would otherwise dial the name
 * it was going to.
 *
 * @template {{ connect: (host: string, port: number) => import('node:net').Socket | undefined }} D
 * @param {D} dialer
 * @param {Map<string, { host: string, port: number | undefined }>} rewrites
 * @returns {D}
 */
export function withDialRewrites(dialer, rewrites) {
  if (rewrites.size === 0) return dialer;
  return {
    ...dialer,
    connect(host, port) {
      const to = rewriteTarget(rewrites, host, port);
      if (to.host === host && to.port === port) return dialer.connect(host, port);
      return dialer.connect(to.host, to.port) ?? netConnect({ host: to.host, port: to.port });
    },
  };
}
