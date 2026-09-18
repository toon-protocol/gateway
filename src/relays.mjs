// Reading relays: one subscription, on every relay that might carry it.
//
// A relay read is free (spec §5 prices the provider's routes, not a relay's
// reads), so this gateway holds no lease, no channel and no money: it opens a
// websocket, sends a REQ and listens. It stays listening — a member
// republishing its Provider Profile, and a Takeover announced by a standby
// (M5-5), both arrive as an EVENT on a subscription that was already open,
// with nobody telling this gateway to look again.
//
// TWO THINGS ONLY (spec §12.1). A gateway reads a relay on a workload's
// account for its members' Profiles and for a Takeover, and for nothing else:
// a grant arrives in a sealed packet, so there is no grant filter here.
//
// Several relays carry the same events, so duplicates are ordinary: the same
// event arrives once per relay and whatever consumes it must be idempotent.

import WebSocket from 'ws';

const RECONNECT_MIN_MS = 250;
const RECONNECT_MAX_MS = 30_000;

/**
 * A pool of relay connections, each carrying subscriptions.
 *
 * @param {{ log?: (line: string) => void, reconnect?: boolean }} [options]
 */
export function createRelayPool({ log = () => {}, reconnect = true } = {}) {
  let closed = false;
  let nextSubscriptionId = 0;
  /** @type {Set<{ relays: string[], filters: object[], onEvent: Function, onEose?: Function, id: string, closed: boolean }>} */
  const subscriptions = new Set();
  /** @type {Map<string, { socket: WebSocket | null, open: boolean, backoff: number, timer: NodeJS.Timeout | null }>} */
  const connections = new Map();

  const connectionFor = (url) => {
    let connection = connections.get(url);
    if (connection !== undefined) return connection;
    connection = { socket: null, open: false, backoff: RECONNECT_MIN_MS, timer: null };
    connections.set(url, connection);
    connect(url, connection);
    return connection;
  };

  const send = (url, message) => {
    const connection = connections.get(url);
    if (connection?.open) connection.socket?.send(JSON.stringify(message));
  };

  const connect = (url, connection) => {
    if (closed) return;
    const socket = new WebSocket(url);
    connection.socket = socket;

    socket.on('open', () => {
      connection.open = true;
      connection.backoff = RECONNECT_MIN_MS;
      log(`relay ${url}: connected`);
      // Everything open is re-subscribed: a relay that was away missed
      // nothing, because a REQ replays what it holds before its EOSE.
      for (const subscription of subscriptions) {
        if (subscription.relays.includes(url) && !subscription.closed) {
          socket.send(JSON.stringify(['REQ', subscription.id, ...subscription.filters]));
        }
      }
    });

    socket.on('message', (raw) => {
      let message;
      try {
        message = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (!Array.isArray(message)) return;
      const [verb, subscriptionId, payload] = message;
      for (const subscription of subscriptions) {
        if (subscription.id !== subscriptionId || subscription.closed) continue;
        if (verb === 'EVENT') subscription.onEvent(payload, url);
        else if (verb === 'EOSE') subscription.onEose?.(url);
      }
    });

    socket.on('error', (error) => {
      log(`relay ${url}: ${error instanceof Error ? error.message : String(error)}`);
    });

    socket.on('close', () => {
      connection.open = false;
      connection.socket = null;
      if (closed || !reconnect) return;
      const delay = connection.backoff;
      connection.backoff = Math.min(connection.backoff * 2, RECONNECT_MAX_MS);
      log(`relay ${url}: closed; reconnecting in ${delay} ms`);
      connection.timer = setTimeout(() => connect(url, connection), delay);
      connection.timer.unref?.();
    });
  };

  return {
    /**
     * Open one subscription across `relays`, and keep it open.
     *
     * `onEvent(event, relayUrl)` is called for every event any of them sends,
     * duplicates included. `onEose(relayUrl)` fires when one relay has sent
     * everything it already held, which is how a caller knows the gateway has
     * caught up rather than that nothing exists.
     *
     * @param {{
     *   relays: string[], filters: object[],
     *   onEvent: (event: any, relayUrl: string) => void,
     *   onEose?: (relayUrl: string) => void,
     * }} subscription
     * @returns {{ close: () => void }}
     */
    subscribe({ relays, filters, onEvent, onEose }) {
      const subscription = {
        relays: [...relays],
        filters,
        onEvent,
        onEose,
        id: `gw-${nextSubscriptionId++}`,
        closed: false,
      };
      subscriptions.add(subscription);
      for (const url of subscription.relays) {
        const connection = connectionFor(url);
        if (connection.open) send(url, ['REQ', subscription.id, ...subscription.filters]);
      }
      return {
        close() {
          subscription.closed = true;
          subscriptions.delete(subscription);
          for (const url of subscription.relays) send(url, ['CLOSE', subscription.id]);
        },
      };
    },

    close() {
      closed = true;
      for (const subscription of subscriptions) subscription.closed = true;
      subscriptions.clear();
      for (const connection of connections.values()) {
        if (connection.timer !== null) clearTimeout(connection.timer);
        connection.socket?.close();
        connection.socket?.terminate?.();
      }
      connections.clear();
    },
  };
}
