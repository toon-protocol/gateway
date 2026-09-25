// A provider's connector, in process: it TERMINATES a sealed packet the way a
// real one does, forwards the body to the `status` handler behind it, and
// seals the answer back (spec §5, §6.5; ADR 0011, connector ADR 0018).
//
// This is the seam M5-4 drives resolution against: one stub per Standby Set
// member, each told what to answer — `running` with `access`, `reserved`,
// `stopped`, an ending, an error, or nothing at all. A member that answers
// anything but `running` is simply not the target, and a member that answers
// nothing is unreachable; both are ordinary here.
//
// IT IS A REAL CONNECTOR AND NOT A SHAPED REPLY, on purpose. The carriage is
// the thing under test (TOON_Network#114): a stub that accepted a plain POST
// would pass for a gateway that never sealed anything, which is exactly the
// bug — every deployment fronts its provider with a connector, and the
// connector answers nothing on a path beside `/ilp`. So the only way to
// produce a reply this gateway can read is to genuinely open what it sealed,
// with the shipped crypto (`@toon-protocol/client`) and nothing reimplemented.
// This is `fake-connector.test-support.ts` from that package, over a socket,
// with the provider's `status` behind it.
//
// What it serves is the client edge a free route needs and no more: `GET /ilp`
// (the self-description, whose `routes` price `<addr>.status` at 0) and
// `POST /ilp` (the packet). Nothing is paid, no claim is presented, and no
// chain is touched — which is the whole point of `status` being free.

import { createServer } from 'node:http';

import {
  decodeEnvelopeRequest,
  deriveFulfillment,
  deserializeIlpPrepare,
  encodeEnvelopeResponse,
  giftWrapPublicKey,
  localGiftWrapEcdh,
  openRequest,
  sealResponse,
  serializeIlpFulfill,
} from '@toon-protocol/client';

import { FIXTURE_ILP_ADDRESS, FIXTURE_SEAL_SECRET } from './events.mjs';
import { peerOf } from './peer.mjs';

/** `{ "error", "message" }` — the refusal shape of every route (spec §5). */
export const refusal = (error, message) => ({ error, message });

/** The usual answer of a member that runs the workload (spec §6.5). */
export const running = ({ workloadId, host = '127.0.0.1', ports = [], sshPort = 40000, expiresAt = 1700003600, role = 'standalone', extra = {} }) => ({
  workload_id: workloadId,
  role,
  state: 'running',
  expires_at: expiresAt,
  access: { host, ssh_port: sshPort, ports },
  ...extra,
});

/** The whole body of an HTTP request, as bytes. */
const bodyOf = (req) =>
  new Promise((resolve) => {
    /** @type {Buffer[]} */
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });

const json = (res, status, value) => {
  const payload = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
};

/**
 * @param {{
 *   pubkey?: string,
 *   ilpAddress?: string,
 *   identitySecret?: Uint8Array,
 *   answer?: (context: { workloadId: string, request: any, continuation: any, gatewayExpiresAt: any, body: any }) => object | undefined,
 *   silent?: boolean,
 *   edge?: (context: { method: string, path: string }) => { status: number, contentType?: string, body: string } | undefined,
 * }} [options]
 *   `answer` returns the JSON body to send; returning `undefined` means the
 *   member answers `unknown_workload`. `silent` means it accepts the
 *   connection and never replies — a member that cannot be reached in time.
 *   `edge` replaces what the CLIENT EDGE itself answers, before a packet is
 *   ever opened: it is how a test stands in a hop that is not a connector at
 *   all — an nginx in front of a provider, say — and sees what this gateway
 *   makes of an answer that is not a `status` (TOON_Network#114).
 */
export async function startStubConnector({
  pubkey,
  ilpAddress = FIXTURE_ILP_ADDRESS,
  identitySecret = FIXTURE_SEAL_SECRET,
  answer,
  silent = false,
  edge,
} = {}) {
  /** @type {{ destination: string, target: string, body: any, request: any, content: any, continuation: any, gatewayExpiresAt: any, peer: { address: string, port: number } }[]} */
  const requests = [];
  let respond = answer ?? (() => undefined);
  let quiet = silent;
  let edgeAnswer = edge;
  const ecdh = localGiftWrapEcdh(identitySecret);

  const server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    const method = req.method ?? 'GET';

    // A test standing in something that is NOT this connector: an nginx that
    // 404s, an HTML error page, an empty body. It is answered before any
    // packet is read, exactly as a hop in front would answer.
    const stood = edgeAnswer?.({ method, path });
    if (stood !== undefined) {
      res.writeHead(stood.status, {
        'content-type': stood.contentType ?? 'text/plain; charset=utf-8',
        'content-length': Buffer.byteLength(stood.body),
      });
      res.end(stood.body);
      return;
    }

    // The self-description a client reads once per connector (connector ADR
    // 0050): who this node is, what it seals with, and that `<addr>.status`
    // is priced at 0 — which is why no claim is ever presented below.
    if (method === 'GET' && (path === '/ilp' || path === '/ilp/')) {
      json(res, 200, {
        ilpAddresses: [ilpAddress],
        httpEndpoint: `http://${req.headers.host}/ilp`,
        btpEndpoint: `ws://${req.headers.host}/ilp/btp`,
        peerCarriages: [],
        edgeIdentity: { keyId: 'stub', publicKey: hex(giftWrapPublicKey(identitySecret)) },
        settlements: [
          {
            chain: 'evm:84532',
            settlementAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
            tokenNetworkRegistry: '0x8263BdD4eB4862395Cb4ef5dA5d637F4b047Eea1',
            tokenNetwork: '0xa79C3b1dbcEA00a6d84735a134395D8eF6D6a478',
            tokenAddress: '0x0C996d7c934c79a6255254875607Fe69df25C0E1',
            decimals: 6,
          },
        ],
        routes: [{ prefix: `${ilpAddress}.status`, price: '0' }],
        supportedVersions: [1],
        defaultVersion: 1,
      });
      return;
    }

    // What one route costs (`client-edge-spec.md` §1.5). Everything this stub
    // terminates is the free `status`, so the answer is always 0 — and a
    // priced route it does not know is a 404, which is how a real edge says
    // "I terminate nothing there".
    if (method === 'GET' && path === '/ilp/routes/price') {
      const destination = new URL(req.url ?? '', 'http://x.invalid').searchParams.get('destination') ?? '';
      if (destination !== `${ilpAddress}.status`) {
        res.writeHead(404, { 'content-length': '0' });
        res.end();
        return;
      }
      json(res, 200, { destination, price: 0 });
      return;
    }

    if (!(method === 'POST' && (path === '/ilp' || path === '/ilp/'))) {
      res.writeHead(404, { 'content-length': '0' });
      res.end();
      return;
    }

    bodyOf(req).then((raw) => {
      const prepare = deserializeIlpPrepare(new Uint8Array(raw));
      const opened = openRequest(prepare.data, ecdh);
      const envelope = decodeEnvelopeRequest(opened.envelopeBytes);
      let body = null;
      try {
        body = JSON.parse(Buffer.from(envelope.body).toString('utf8') || 'null');
      } catch {
        /* recorded as null below */
      }
      const request = body?.request;
      const content = request?.content ?? null;
      requests.push({
        /** The ILP route the packet was addressed to: `<ilp_address>.status` (spec §5). */
        destination: prepare.destination,
        /** The path BENEATH the route's handler, which a `status` never needs. */
        target: envelope.target,
        body,
        request,
        content,
        /** The Gateway Grant the gateway presented, where a token would ride. */
        continuation: request?.continuation,
        gatewayExpiresAt: content?.gateway_expires_at,
        // Who connected: a gateway directly, or a proxy on its behalf (M5-6).
        peer: peerOf(req),
      });

      if (quiet) return; // connected, and never answered.

      const answered =
        respond({
          workloadId: content?.workload_id,
          request,
          continuation: request?.continuation,
          gatewayExpiresAt: content?.gateway_expires_at,
          body,
        }) ?? refusal('unknown_workload', 'this provider never leased that workload id');
      const payload = Buffer.from(JSON.stringify(answered), 'utf8');
      // The app's own answer, sealed back with the secret the request carried:
      // the only thing that could have produced it is a party that opened the
      // request, which is what makes a sealed exchange one exchange.
      const sealed = sealResponse(
        opened.sharedSecret,
        encodeEnvelopeResponse({
          status: answered.error === undefined ? 200 : 403,
          headers: [['content-type', 'application/json; charset=utf-8']],
          body: new Uint8Array(payload),
        }),
      );
      const fulfil = serializeIlpFulfill({
        fulfillment: deriveFulfillment(opened.sharedSecret),
        data: sealed,
      });
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(fulfil.length),
      });
      res.end(Buffer.from(fulfil));
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const { port } = /** @type {{ port: number }} */ (server.address());

  return {
    /** The provider whose connector this is, for its Profile and `standby_set`. */
    pubkey,
    host: '127.0.0.1',
    port,
    /** What a Provider Profile's `connector_url` points at (spec §4.1). */
    url: `http://127.0.0.1:${port}/ilp`,
    /** What its Profile's `ilp_address` says, and the prefix of its routes (spec §5). */
    ilpAddress,
    /** The free `status` route of this member: what a gateway addresses. */
    destination: `${ilpAddress}.status`,

    /** Every request this connector was sent, parsed. */
    get requests() {
      return [...requests];
    },

    /** Change what it answers, mid-test. */
    answerWith(next) {
      respond = next;
    },

    /** Stand in something that is not this connector at all, or stop. */
    edgeAnswers(next) {
      edgeAnswer = next;
    },

    /** Stop answering (a member that goes unreachable), or start again. */
    goSilent(value = true) {
      quiet = value;
    },

    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve(undefined)));
    },
  };
}

/** `0x`-prefixed hex, exactly as a connector reports its sealing key. */
const hex = (bytes) => `0x${Buffer.from(bytes).toString('hex')}`;
