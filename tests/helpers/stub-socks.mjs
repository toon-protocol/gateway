// A stub SOCKS5 proxy, so a gateway's `.anyone` dialling can be tested against
// a proxy the test controls rather than an `anon` daemon (spec §10, §12.8).
//
// It speaks exactly as much of RFC 1928 as one client needs: the greeting,
// the no-authentication method, and `CONNECT` to a `DOMAINNAME` or an IP.
// Once connected it is a pipe. It is the provider's `tests/common/socks.rs`,
// in Node.
//
// What makes it a TEST and not just a hop: a destination is NAMED to it, and
// it alone knows where that name really is. A stub is started with a routing
// table of `"lease.anyone" -> <a stub workload's real address>` pairs, and the
// gateway is told the NAME. Nothing resolves `lease.anyone` on this host, so a
// gateway that dialled directly could not reach the workload at all — which is
// why `destinations` recording the name is proof the connection went through
// the proxy, and why the name arriving as a `DOMAINNAME` rather than an
// address is proof the gateway resolved nothing itself (`socks5h`, not
// `socks5`).
//
// `outgoing` closes the other half: every connection the stub makes on the
// gateway's behalf leaves from a local port recorded here, so a stub that
// records its peers can assert that EVERY connection it saw came from this
// proxy and none from anywhere else.

import { connect, createServer, isIP } from 'node:net';

/** A refusal: `[ver, rep, rsv, atyp=IPv4, 0.0.0.0, port 0]`. `rep` is the RFC 1928 code. */
const reply = (code) => Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]);

const HOST_UNREACHABLE = 4;
const CONNECTION_REFUSED = 5;

/**
 * Read exactly `n` bytes from a socket, or `null` if it ended first.
 *
 * @param {import('node:net').Socket} socket
 * @param {number} n
 * @returns {Promise<Buffer | null>}
 */
const readExactly = (socket, n) =>
  new Promise((resolve) => {
    const attempt = () => {
      const chunk = socket.read(n);
      if (chunk !== null) {
        socket.removeListener('readable', attempt);
        socket.removeListener('end', ended);
        resolve(chunk);
      }
    };
    const ended = () => {
      socket.removeListener('readable', attempt);
      resolve(null);
    };
    socket.on('readable', attempt);
    socket.once('end', ended);
    attempt();
  });

/** The greeting: the client's method list in, "no authentication" out. */
const greet = async (client) => {
  const head = await readExactly(client, 2);
  if (head === null || head[0] !== 5) return false;
  if ((await readExactly(client, head[1])) === null) return false;
  client.write(Buffer.from([5, 0]));
  return true;
};

/** One `CONNECT`, as the host and port it named, or `null` for anything else. */
const request = async (client) => {
  const head = await readExactly(client, 4);
  // ver 5, cmd 1 (CONNECT). Nothing here binds or associates UDP.
  if (head === null || head[0] !== 5 || head[1] !== 1) return null;
  let host;
  let type;
  if (head[3] === 1) {
    const octets = await readExactly(client, 4);
    if (octets === null) return null;
    host = [...octets].join('.');
    type = 'ipv4';
  } else if (head[3] === 3) {
    const length = await readExactly(client, 1);
    const name = length === null ? null : await readExactly(client, length[0]);
    if (name === null) return null;
    host = name.toString('utf8');
    type = 'domain';
  } else if (head[3] === 4) {
    const octets = await readExactly(client, 16);
    if (octets === null) return null;
    const groups = [];
    for (let i = 0; i < 16; i += 2) groups.push(octets.readUInt16BE(i).toString(16));
    host = groups.join(':');
    type = 'ipv6';
  } else {
    return null;
  }
  const port = await readExactly(client, 2);
  if (port === null) return null;
  return { host, port: port.readUInt16BE(0), type };
};

/**
 * Start a stub SOCKS5 proxy on a free loopback port.
 *
 * @param {{ routes?: Record<string, { host: string, port: number }> }} [options]
 *   `routes` maps a name (`lease.anyone`) to where it really is. A `CONNECT`
 *   to an IP literal is dialled as given; a name in no route is refused with
 *   "host unreachable", the way a daemon with no circuit to a hidden service
 *   answers.
 */
export async function startStubSocks({ routes = {} } = {}) {
  /** @type {Map<string, { host: string, port: number }>} */
  const table = new Map(Object.entries(routes).map(([name, to]) => [name.toLowerCase(), to]));
  /** `<host>:<port>` exactly as each `CONNECT` named it, in order. */
  /** @type {{ host: string, port: number, type: string }[]} */
  const destinations = [];
  /** The local address of every connection this proxy opened onward. */
  /** @type {{ address: string, port: number }[]} */
  const outgoing = [];
  /** @type {Set<import('node:net').Socket>} */
  const open = new Set();

  const serve = async (client) => {
    if (!(await greet(client))) return client.destroy();
    const wanted = await request(client);
    if (wanted === null) return client.destroy();
    destinations.push(wanted);

    const target = isIP(wanted.host) ? { host: wanted.host, port: wanted.port } : table.get(wanted.host.toLowerCase());
    if (target === undefined) {
      client.end(reply(HOST_UNREACHABLE));
      return undefined;
    }
    const upstream = connect(target.port, target.host);
    open.add(upstream);
    upstream.on('close', () => open.delete(upstream));
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
    upstream.once('connect', () => {
      outgoing.push({ address: upstream.localAddress ?? '', port: upstream.localPort ?? 0 });
      // Success. The bound address a real proxy reports is not one any client
      // here looks at, so it is reported as `0.0.0.0:0`.
      client.write(reply(0));
      client.pipe(upstream);
      upstream.pipe(client);
    });
    upstream.once('error', () => {
      if (!client.destroyed) client.end(reply(CONNECTION_REFUSED));
    });
    return undefined;
  };

  const server = createServer((client) => {
    open.add(client);
    client.on('close', () => open.delete(client));
    client.on('error', () => {});
    serve(client).catch(() => client.destroy());
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const { port } = /** @type {{ port: number }} */ (server.address());

  return {
    host: '127.0.0.1',
    port,
    /** `socks5h://127.0.0.1:<port>`, as `TOON_SOCKS_PROXY` names it. */
    url: `socks5h://127.0.0.1:${port}`,

    /** Every destination a client asked this proxy to connect to, as named. */
    get destinations() {
      return [...destinations];
    },

    /** Whether some client asked for `host:port`. */
    askedFor: (host, port) =>
      destinations.some((d) => d.host.toLowerCase() === host.toLowerCase() && d.port === port),

    /** The local address of every onward connection: what a stub sees as its peer. */
    get outgoing() {
      return [...outgoing];
    },

    /** Whether a connection a stub saw from `peer` came through this proxy. */
    opened: (peer) => outgoing.some((o) => o.port === peer?.port && o.address === peer?.address),

    async close() {
      for (const socket of open) socket.destroy();
      await new Promise((resolve) => server.close(() => resolve(undefined)));
    },
  };
}
