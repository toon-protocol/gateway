// How this gateway opens a TCP connection, and the one kind of host it never
// opens one to directly (spec §10, §12.8).
//
// Every outbound connection a gateway makes — asking a member for `status`,
// and forwarding a tenant's request to the workload — goes through ONE seam:
// `connect(host, port)` returns a socket on its way, or `undefined` meaning
// "an ordinary direct dial". Both legs share it on purpose, because both legs
// can land on a Hidden Provider: its connector is at an `.anyone` address and
// so is every lease it runs (ADR 0008), and a gateway that got one leg right
// and the other wrong would leak exactly what hiding is for.
//
// An `.anyone` address is dialled through the configured `socks5h://` proxy —
// an `anon` client — and the gateway is an ordinary client of it: the name
// goes to the proxy as a name, the proxy builds the circuit, and this process
// learns nothing about where the provider is. Any other host is dialled
// directly, so a Standby Set that mixes a public member with a hidden one
// works with no configuration beyond the proxy.
//
// An `.anyone` host has no meaning to a system resolver, and handing one to
// `getaddrinfo` would put a hidden service into a plaintext DNS query. So with
// no proxy configured such a dial is REFUSED, loudly and before anything is
// tried, rather than attempted and failed: the tenant is told `no_proxy`, and
// no resolver ever saw the name.

import { connect as tlsConnect } from 'node:tls';

import { validateSocks5hUrl } from '@toon-protocol/client';
import { DEFAULT_HS_CONNECT_TIMEOUT_MS } from '@toon-protocol/client/hidden-service';
import { SocksClient } from 'socks';

import { unavailable } from './reasons.mjs';

/**
 * How long to wait for the proxy to reach an `.anyone` address.
 *
 * The client's own figure, because it is the same wait: a circuit to a cold
 * hidden service routinely takes longer than a TCP connect, and a short limit
 * turns "slow" into "unreachable". It bounds the DIAL; how long a `status`
 * answer or a forwarded response may take is its caller's business.
 */
export const ANYONE_CONNECT_TIMEOUT_MS = DEFAULT_HS_CONNECT_TIMEOUT_MS;

/** Whether a host is an `.anyone` address, which is never dialled directly. */
export const isAnyoneHost = (host) =>
  typeof host === 'string' && /\.anyone\.?$/i.test(host.replace(/^\[|\]$/g, ''));

/**
 * A dial this gateway will not make: an `.anyone` address with no proxy to
 * reach it through. It is a refusal, not a failure — nothing was tried.
 */
export class NoProxyError extends Error {
  /**
   * @param {string} host
   * @param {number} port
   */
  constructor(host, port) {
    super(
      `${host}:${port} is an \`.anyone\` address, which is never resolved or dialled directly ` +
        '(spec §12.8), and this gateway has no TOON_SOCKS_PROXY to reach one through',
    );
    this.name = 'NoProxyError';
    this.host = host;
    this.port = port;
  }
}

/**
 * The refusal a dial that this gateway would not make becomes, or `undefined`
 * when the dial was made and merely failed (which is the caller's
 * `member_unreachable`).
 *
 * @param {unknown} e
 * @param {string} workloadId
 */
export const refusalFor = (e, workloadId) =>
  e instanceof NoProxyError
    ? unavailable('no_proxy', { workloadId, address: `${e.host}:${e.port}` })
    : undefined;

/**
 * @typedef {(host: string, port: number) => Promise<import('node:net').Socket> | undefined} Dial
 *   A socket on its way to `host:port`, or `undefined` for an ordinary direct
 *   dial. Throws `NoProxyError` for an `.anyone` host it has no proxy for.
 */

/**
 * The `http.request` options that dial `host:port` the way this gateway
 * should: the dialler's socket when it is giving one, otherwise `agent`.
 *
 * It lives beside `connect` rather than beside either caller, because asking a
 * member for `status` and forwarding to a workload must dial the same way —
 * one of them getting it wrong is exactly what hiding is for.
 *
 * A dial the dialler refuses THROWS here, synchronously, so a caller answers
 * the tenant before any request object exists. A dial it makes is a promise,
 * handed to `http.request` in the callback form its `createConnection`
 * accepts: the request is written once the SOCKS handshake is done, and a
 * handshake that fails is the request's own `error`.
 *
 * `agent` is a keep-alive pool the caller owns; without one, `agent: false`
 * gives a fresh connection that no global pool outlives a shutdown with.
 *
 * `secure` is for an `https://` destination: a socket the dialler gave is a
 * raw one, and `https.request` puts TLS only on sockets its own agent made —
 * so it is put on here, or plaintext would go onto the circuit.
 *
 * @param {Dial | undefined} connect
 * @param {string} host
 * @param {number} port
 * @param {import('node:http').Agent | undefined} agent
 * @param {{ secure?: boolean }} [options]
 */
export const connectionOptions = (connect, host, port, agent, { secure = false } = {}) => {
  const dialling = connect?.(host, port);
  if (dialling === undefined) return { agent: agent ?? false };
  const ready = secure ? dialling.then((socket) => secured(socket, host)) : dialling;
  return {
    createConnection: (_options, callback) => {
      ready.then(
        (socket) => callback(null, socket),
        (e) => callback(e instanceof Error ? e : new Error(String(e))),
      );
      return undefined;
    },
  };
};

/** TLS over a socket already connected, verified for `host` as any client would. */
const secured = (socket, host) =>
  new Promise((resolve, reject) => {
    const tls = tlsConnect({ socket, servername: host, ALPNProtocols: ['http/1.1'] });
    tls.once('secureConnect', () => resolve(tls));
    tls.once('error', reject);
  });

/**
 * The dialler this gateway uses.
 *
 * @param {{ socksProxy?: string, connectTimeoutMs?: number }} [options]
 * @returns {{ connect: Dial }}
 */
export function createDialer({ socksProxy, connectTimeoutMs = ANYONE_CONNECT_TIMEOUT_MS } = {}) {
  // Parsed once, here, so that a proxy the config accepted is the proxy that
  // is dialled — and `socks5h`, never `socks5`: the trailing `h` is the proxy
  // resolving the name, which is the whole point.
  const proxy = socksProxy === undefined ? undefined : validateSocks5hUrl(socksProxy);

  return {
    connect(host, port) {
      if (!isAnyoneHost(host)) return undefined;
      if (proxy === undefined) throw new NoProxyError(host, port);
      // `socks` sends a name as a DOMAINNAME (RFC 1928 ATYP 3) and resolves
      // nothing itself; the proxy does, at the far end of the circuit.
      return SocksClient.createConnection({
        proxy: { host: proxy.host, port: proxy.port, type: 5 },
        command: 'connect',
        destination: { host, port },
        timeout: connectTimeoutMs,
      }).then(({ socket }) => {
        socket.setNoDelay(true);
        return socket;
      });
    },
  };
}
