// A NIP-01 relay, in process.
//
// The gateway talks to this over a real WebSocket with its real relay client,
// so a test asserts on what the gateway DID with what a relay said, never on
// what it stored. It holds whatever a test gives it — Provider Profiles,
// Gateway Grants, Takeover events — and `publish` delivers to subscriptions
// that are already open, which is how a test makes something happen to a
// running gateway (a grant replaced, a Takeover announced) mid-test.
//
// It is a stub, not a relay: no persistence, no NIP-42, no rate limit.

import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

/** Whether one event matches one NIP-01 filter. */
export function matchesFilter(event, filter) {
  if (filter.ids && !filter.ids.includes(event.id)) return false;
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
  if (filter.authors && !filter.authors.includes(event.pubkey)) return false;
  if (filter.since !== undefined && event.created_at < filter.since) return false;
  if (filter.until !== undefined && event.created_at > filter.until) return false;
  for (const [key, wanted] of Object.entries(filter)) {
    if (!key.startsWith('#')) continue;
    const name = key.slice(1);
    const values = event.tags.filter((t) => t[0] === name).map((t) => t[1]);
    if (!values.some((v) => wanted.includes(v))) return false;
  }
  return true;
}

const isAddressable = (kind) => kind >= 30000 && kind < 40000;
const isReplaceable = (kind) => (kind >= 10000 && kind < 20000) || kind === 0 || kind === 3;

/** The key a relay replaces on: `<kind>:<pubkey>:<d>` for an addressable event. */
const replacementKey = (event) => {
  if (isAddressable(event.kind)) {
    const d = event.tags.find((t) => t[0] === 'd')?.[1] ?? '';
    return `${event.kind}:${event.pubkey}:${d}`;
  }
  if (isReplaceable(event.kind)) return `${event.kind}:${event.pubkey}:`;
  return null;
};

/**
 * Start a stub relay.
 *
 * @param {{ events?: object[], strictReplacement?: boolean }} [options]
 *   `strictReplacement` is a real relay's rule — an older replaceable event is
 *   refused and never delivered. Turn it off to drive a gateway with events a
 *   real relay would have dropped.
 */
export async function startStubRelay({ events = [], strictReplacement = true } = {}) {
  /** @type {object[]} */
  const stored = [];
  /** @type {{ socket: import('ws').WebSocket, id: string, filters: object[] }[]} */
  const subscriptions = [];
  /** @type {object[]} */
  const requests = [];

  const store = (event) => {
    const key = replacementKey(event);
    if (key === null) {
      stored.push(event);
      return true;
    }
    const held = stored.find((e) => replacementKey(e) === key);
    if (held === undefined) {
      stored.push(event);
      return true;
    }
    const newer =
      event.created_at > held.created_at ||
      (event.created_at === held.created_at && event.id < held.id);
    if (strictReplacement && !newer) return false;
    stored.splice(stored.indexOf(held), 1, event);
    return true;
  };

  const http = createServer();
  const wss = new WebSocketServer({ server: http });

  wss.on('connection', (socket) => {
    socket.on('message', (raw) => {
      let message;
      try {
        message = JSON.parse(String(raw));
      } catch {
        socket.send(JSON.stringify(['NOTICE', 'invalid JSON']));
        return;
      }
      const [verb, ...rest] = message;
      if (verb === 'REQ') {
        const [id, ...filters] = rest;
        requests.push({ id, filters });
        subscriptions.push({ socket, id, filters });
        for (const event of stored) {
          if (filters.some((f) => matchesFilter(event, f))) {
            socket.send(JSON.stringify(['EVENT', id, event]));
          }
        }
        socket.send(JSON.stringify(['EOSE', id]));
      } else if (verb === 'CLOSE') {
        const [id] = rest;
        for (let i = subscriptions.length - 1; i >= 0; i -= 1) {
          if (subscriptions[i].socket === socket && subscriptions[i].id === id) {
            subscriptions.splice(i, 1);
          }
        }
      } else if (verb === 'EVENT') {
        const [event] = rest;
        const accepted = store(event);
        socket.send(JSON.stringify(['OK', event.id, accepted, accepted ? '' : 'replaced: have a newer event']));
        if (accepted) deliver(event);
      }
    });
    socket.on('close', () => {
      for (let i = subscriptions.length - 1; i >= 0; i -= 1) {
        if (subscriptions[i].socket === socket) subscriptions.splice(i, 1);
      }
    });
  });

  const deliver = (event) => {
    for (const subscription of subscriptions) {
      if (subscription.filters.some((f) => matchesFilter(event, f))) {
        subscription.socket.send(JSON.stringify(['EVENT', subscription.id, event]));
      }
    }
  };

  for (const event of events) store(event);

  await new Promise((resolve) => http.listen(0, '127.0.0.1', () => resolve(undefined)));
  const { port } = /** @type {{ port: number }} */ (http.address());

  return {
    url: `ws://127.0.0.1:${port}`,

    /** Put an event in, and hand it to every subscription already open. */
    publish(event) {
      const accepted = store(event);
      if (accepted) deliver(event);
      return accepted;
    },

    /** Every event the relay holds now. */
    get events() {
      return [...stored];
    },

    /** Every REQ this relay was sent: `{ id, filters }`. */
    get requests() {
      return [...requests];
    },

    /** How many subscriptions are open right now. */
    get openSubscriptions() {
      return subscriptions.length;
    },

    /** Drop every connection without closing the relay — a relay going away. */
    dropConnections() {
      for (const client of wss.clients) client.terminate();
    },

    async close() {
      for (const client of wss.clients) client.terminate();
      await new Promise((resolve) => wss.close(() => resolve(undefined)));
      await new Promise((resolve) => http.close(() => resolve(undefined)));
    },
  };
}
