# The Workload Gateway

A stable HTTPS name for a TOON Network workload, keyed by its **workload id**.

A workload is reachable today only at whichever provider is running it, on a
host and a port that provider chose — and a [Hidden Provider][hidden] has no
host at all. A Takeover moves the workload to a different provider, with a
different host and a different port, with no tenant online to help. So a name
owned by a provider names something that can move out from under it.

This process owns the name instead. It is an ordinary TOON app, reached
through its own connector, that fronts a workload by its workload id and
resolves that id to whichever provider is running it right now ([ADR 0013][adr13],
spec §12). The provider protocol gains nothing for it: no provider owns a
domain, runs ACME, terminates TLS or holds a tenant's certificate key.

**It holds no lease, pays for nothing and calls no paid route.** Its whole
authority is the **Gateway Grant** (spec §3.1.3) — a tenant's signed,
published delegation naming one gateway, one workload, the workload's HTTP
port and its Standby Set, with an expiry. Reading a relay is free, and the
grant is what a `status` request carries to be answered (spec §6.5).

## How a workload arrives here

Nobody makes contact with this process. A tenant publishes a Gateway Grant
naming this gateway's public key, and this gateway finds it: **one** filter,
kind `30438` with `#p` equal to its own key, on the relays it watches. A grant
is addressable on its workload id, so publishing again under the same id
**replaces** the one this gateway holds — renewal, rotation and a change of
Standby Set are all the same act, and all take effect with no restart.

```
tenant  ──publish grant (kind 30438, p=<gateway>)──▶  relay
                                                        │
gateway ──REQ {kinds:[30438], "#p":["<gateway>"]}───────┘
        ──serves https://<canonical>.<gateway-domain>/
```

## The canonical hostname

Every granted workload is served at

```
<canonical label>.<gateway domain>
```

where the canonical label is the **lowercase, unpadded base32 (RFC 4648) of
the 32-byte workload id** — 52 characters, where the 64 hex characters of the
same id would not fit a 63-character DNS label. It is derived, never assigned:
two gateways holding the same grant serve the same label, and a Takeover
changes nothing about the name.

```
workload id  aaaaaaaa…aaaa  (32 bytes of 0xaa)
label        vkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkva
served at    https://vkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkvkva.gw.example/
```

A grant may also carry a readable `name`. It is carried and validated for
shape here; serving it is M5-4's.

## Configuration

Environment only; there is no config file.

| Variable | Default | Meaning |
|---|---|---|
| `GATEWAY_SECRET_KEY` | — | **Required.** This gateway's Nostr identity, 64 hex characters. The key a tenant names in a grant, and the key this process signs `status` with. An `nsec…` is not accepted; decode it first. |
| `GATEWAY_DOMAIN` | — | **Required.** Every workload is served at `<canonical label>.<domain>`. Point a wildcard `*.<domain>` at this process. |
| `GATEWAY_RELAYS` | — | **Required.** Comma-separated `ws://`/`wss://` relays to watch for grants. |
| `GATEWAY_TLS_CERT` / `GATEWAY_TLS_KEY` | — | Paths to the certificate and key for `*.<GATEWAY_DOMAIN>`. Required unless `GATEWAY_HTTP_PORT` is set. |
| `GATEWAY_HTTPS_PORT` | `443` | Where TLS is terminated. |
| `GATEWAY_HTTP_PORT` | — | A plain-HTTP listener, for development or for a deployment terminating TLS in front. Set it or the certificate pair, or this process refuses to start. |
| `GATEWAY_BIND_ADDR` | `0.0.0.0` | What to listen on. |
| `TOON_SOCKS_PROXY` | — | `socks5h://<host>:<port>` for `.anyone` hosts. Validated at startup; **dialled from M5-6**. The scheme must be `socks5h`: under plain `socks5` this process would resolve the destination itself, putting a hidden service into a plaintext DNS query. |

Startup collects **every** missing or malformed key and refuses with all of
them at once:

```
[gateway] this Workload Gateway cannot start:
  - GATEWAY_SECRET_KEY is required: it is this gateway's Nostr identity …
  - GATEWAY_DOMAIN is required: every workload is served at <canonical label>.<domain>.
  - this gateway has nothing to listen on: set GATEWAY_TLS_CERT and GATEWAY_TLS_KEY …
```

A half-configured gateway is worse than one that will not start: it answers a
tenant's hostname with nothing, and nothing is exactly what a stopped workload
and a broken gateway look like from outside.

## Running it

```sh
npm install

# development: a plain listener, no certificate
GATEWAY_SECRET_KEY=<64 hex> \
GATEWAY_DOMAIN=gw.localhost \
GATEWAY_RELAYS=ws://localhost:7100 \
GATEWAY_HTTP_PORT=8080 \
npm start

# production: TLS for *.gw.example
GATEWAY_SECRET_KEY=<64 hex> \
GATEWAY_DOMAIN=gw.example \
GATEWAY_RELAYS=wss://relay.one,wss://relay.two \
GATEWAY_TLS_CERT=/etc/tls/fullchain.pem \
GATEWAY_TLS_KEY=/etc/tls/privkey.pem \
npm start
```

TLS is terminated here, for **this** gateway's domain, with **this** gateway's
certificate — which is the point: a workload is reachable over HTTPS while
holding no certificate itself, and no provider in the Standby Set ever sees a
certificate key.

## Its own connector

ADR 0013 puts a gateway behind its own connector, like any other TOON app. In
this milestone **that connector terminates no paid route**: nothing a tenant
asks this process for is sold, and this process buys nothing either. It holds
no payment channel, no mnemonic and no lease, and it never calls a paid route
— so there is no connector configuration here to get wrong. What a deployment
puts in front of these listeners (a connector, a load balancer, nothing at
all) is its own choice, and the plain-HTTP listener is there for the case
where TLS is terminated ahead of this process.

## The error page

Until a workload resolves, and whenever it cannot, a request is answered `503`
with a body naming **why**, so a tenant can tell a stopped workload from an
expired grant from a broken gateway. The body is `{ "error", "message" }` —
the shape every provider route answers a refusal in (spec §5) — or an HTML
page when a browser asks for one, and the reason is repeated in a
`toon-gateway-reason` response header.

| Reason | Means |
|---|---|
| `no_grant` | This hostname names no workload this gateway has been granted. |
| `grant_expired` | The grant ran out. Publishing it again renews it, with no restart. |
| `not_resolved` | A grant is held, but where the workload runs is not known yet. |

A request to a hostname with no grant — an unknown label, the bare domain, a
deeper name, or a name under somebody else's domain — **never reaches a
provider or a workload**: nothing is dialled at all.

The vocabulary is one table, `REASONS` in [`src/reasons.mjs`](src/reasons.mjs).
Add a row (or call `defineReason`) and the HTTP status, the JSON body, the
HTML page and the header all follow. M5-4 adds *no running member* and *member
unreachable*; M5-6 adds *no proxy configured*.

## What is here

| File | What it is |
|---|---|
| `src/main.mjs` | The process: read the environment, refuse or start, handle signals. |
| `src/config.mjs` | The configuration, and the refusal naming everything missing. |
| `src/gateway.mjs` | The composition: listeners, the grant subscription, `stop()`. |
| `src/serve.mjs` | The request path: hostname → grant → the resolver seam, and the refusals. |
| `src/grants.mjs` | The grants held: one per workload, replacement, the hostname index. |
| `src/grant.mjs` | Reading one Gateway Grant event, or saying which field is wrong. |
| `src/relays.mjs` | The relay pool: subscriptions that stay open, and the grant filter. |
| `src/hostname.mjs` | The canonical label: base32, and reading a label out of a `Host`. |
| `src/nostr.mjs` | NIP-01: serialize, id, verify, sign. |
| `src/reasons.mjs` | The `503` vocabulary. |
| `src/kinds.mjs` | The kind numbers, pinned to the provider's fixtures by a test. |

## Tests

```sh
npm test        # node --test
npm run typecheck
```

Everything is driven **at the gateway's own listening port**, in process,
against a stub relay, stub provider connectors and stub workloads. Nothing
asserts on what the gateway holds internally — a test written that way passes
when the gateway is broken in exactly the way that matters.

[`tests/harness.test.mjs`](tests/harness.test.mjs) is the smallest working
example of each piece; read it first.

```js
const gateway = await startTestGateway({
  events: [gatewayGrant({ workloadId, gateway: GATEWAY.public_key })],
  resolve: myResolver,           // the seam M5-4 fills in
});
t.after(() => gateway.close());

const answered = await gateway.get(gateway.hostFor(workloadId), { path: '/orders' });
gateway.publish(takeover({ workloadId }));   // mid-test, into the relay it watches
```

| Helper | Gives you |
|---|---|
| `tests/helpers/harness.mjs` | `startTestGateway`, `gateway.get(host)`, `gateway.publish(event)`, `hostFor`, `untilServed`, `untilReason`, `until`. |
| `tests/helpers/stub-relay.mjs` | A NIP-01 relay: holds Profiles, grants and Takeover events; `publish` reaches subscriptions already open; replaces addressable events as a relay does. |
| `tests/helpers/stub-connector.mjs` | A provider's connector answering `POST /status` (spec §6.5). `answerWith` to change the answer, `goSilent` for a member that never replies, `requests` for what it was asked and who signed it. |
| `tests/helpers/stub-workload.mjs` | The tenant's application: records method, URL, headers and body, and echoes over WebSocket. |
| `tests/helpers/events.mjs` | Signed `gatewayGrant`, `providerProfile`, `takeover`, `liveness`, and `CONSTANTS` — the test-only keys and clock every wire fixture was generated in. |

The wire fixtures in `tests/fixtures/wire/` are copied from the provider
(`toon-provider`, `tests/wire_fixtures.rs`) and are the ground truth: if this
code disagrees with them, this code is wrong.

## The resolver seam

`startGateway({ config, resolve })` takes a resolver. It is called only once a
request's hostname has been matched to a grant that is in force:

```js
/**
 * @param {{ grant, req, res?, socket?, head?, secure }} context
 * @returns {Promise<{ unavailable: Unavailable } | any>}
 */
```

Returning `{ unavailable }` — from `unavailable('<reason>', { … })` — answers
the error page. Returning **anything else, nothing included**, means the
resolver answered the request itself: M5-4 forwards it to whichever Standby Set
member is running the workload. A resolver that throws is logged and answered
`not_resolved`, so a bug here is never a dropped connection. WebSocket upgrades
arrive at the same resolver with `socket` and `head` in place of `res`.

Without one, the gateway answers `not_resolved`: this milestone stops one step
short of the workload on purpose.

Spec and ADR references are to `toon-protocol/TOON_Network`:
`docs/spec/toon-network-v1.md` and
`docs/adr/0013-hostnames-and-tls-live-in-a-workload-gateway.md`.

[adr13]: https://github.com/toon-protocol/TOON_Network/blob/main/docs/adr/0013-hostnames-and-tls-live-in-a-workload-gateway.md
[hidden]: https://github.com/toon-protocol/TOON_Network/blob/main/docs/spec/toon-network-v1.md#10-hidden-provider
