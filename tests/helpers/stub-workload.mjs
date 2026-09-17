// A workload, in process: an HTTP server that records exactly what reached it.
//
// It is what a test asserts FORWARDING against (M5-4): the `Host` the tenant
// used, the `X-Forwarded-*` headers, the path, the body, and — through a stub
// SOCKS proxy — whether the connection came the way it was supposed to (M5-6).
// It never speaks the provider protocol; it is the tenant's application.

import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

/**
 * @param {{
 *   body?: string | ((req: import('node:http').IncomingMessage) => string),
 *   status?: number,
 *   websocket?: boolean,
 * }} [options]
 */
export async function startStubWorkload({ body = 'hello from the workload', status = 200, websocket = true } = {}) {
  /** @type {{ method: string, url: string, headers: Record<string, string>, body: string }[]} */
  const requests = [];
  /** @type {{ url: string, headers: Record<string, string>, messages: string[] }[]} */
  const upgrades = [];

  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      requests.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: /** @type {Record<string, string>} */ ({ ...req.headers }),
        body: Buffer.concat(chunks).toString('utf8'),
      });
      const payload = typeof body === 'function' ? body(req) : body;
      res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(payload);
    });
  });

  // An application that holds a connection open, so a gateway that does not
  // pass an upgrade through is a failing test rather than a silent downgrade.
  if (websocket) {
    const wss = new WebSocketServer({ server });
    wss.on('connection', (socket, req) => {
      const record = {
        url: req.url ?? '',
        headers: /** @type {Record<string, string>} */ ({ ...req.headers }),
        messages: /** @type {string[]} */ ([]),
      };
      upgrades.push(record);
      socket.on('message', (raw) => {
        record.messages.push(String(raw));
        socket.send(`echo:${String(raw)}`);
      });
    });
  }

  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const { port } = /** @type {{ port: number }} */ (server.address());

  return {
    host: '127.0.0.1',
    port,
    url: `http://127.0.0.1:${port}`,
    /** Every HTTP request that reached the workload. */
    get requests() {
      return [...requests];
    },
    /** Every WebSocket connection that reached it, and what came over it. */
    get upgrades() {
      return [...upgrades];
    },
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve(undefined)));
    },
  };
}
