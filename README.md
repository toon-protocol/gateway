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

## Where the workload actually is

The hostname is half of it; the other half is finding which provider is
running the workload right now, and sending the request there.

**Resolution follows the grant and nothing else.** The grant names the Standby
Set. Each member's **Provider Profile** (spec §4.1) gives its `connector_url`
and its Relay Set — a gateway looks for Profiles on the relays it is
configured with, and then on the relays a Profile itself names, because a
provider publishes to its *own* Relay Set. Every member is then sent `status`
(spec §6.5) **at once**, each request signed by this gateway's own key and
carrying the whole signed grant:

```
grant.standby_set  ──▶  Profile(member).connector_url  ──POST status──▶  member
                                                       ◀── state, access ──
```

The **running member** is the one answering `state: "running"` with `access`.
A member answering `reserved`, `stopped` or an ending is simply not the target
— that is a Warm Standby doing its job, not a failure. A member that *refuses*
(`bad_grant`, `unknown_workload`) is a third thing: it answered, and it told
this gateway nothing about the lease, so it is counted with the members that
could not be reached rather than with the ones that answered. Asking all members rather than the primary first is
the point: a Takeover moves a workload with no tenant online to say so, so the
member listed first is exactly the one that may no longer have it.

The **target port** is the `host_port` of the `access.ports` entry whose
`container_port` equals the grant's `http_port`. Not the first port, and not
`ssh_port`: a workload commonly exposes several, the host ports are the
provider's to choose, and `http_port` is in the grant precisely so that
nothing has to be guessed.

## What a forwarded request carries

Plain HTTP/1.1 forwarding, with three things fixed because applications depend
on them (spec §12.5):

| Header | What the workload sees |
|---|---|
| `Host` | **The name the tenant used**, untouched. An application that builds absolute URLs, sets a cookie domain or picks a virtual host from `Host` keeps working. |
| `X-Forwarded-For` | Where the request came from, appended to any chain already there. |
| `X-Forwarded-Proto` | The scheme the **tenant** used — `https` wherever TLS was terminated here, whatever this hop is. |
| `X-Forwarded-Host` | The same name as `Host`, for a framework configured to trust this one instead. |

Hop-by-hop headers are not forwarded in either direction, and **WebSocket
upgrades are passed through**: the handshake is replayed to the workload and
the two connections joined, so an application that holds a connection open
works behind a gateway. Nothing is required of the workload — no header to
read, no path prefix, no agent inside it.

## A readable name

A grant may also carry a `name`. It is served at `<name>.<GATEWAY_DOMAIN>`
**first come, first served**: only when it is a single DNS label and no grant
still in force here already holds it. A name that fails either is logged and
ignored and **costs the grant nothing else** — both workloads keep their
canonical hostnames, which is the name a tenant can always derive and can
never lose to somebody else's grant. So a readable name is either one
workload's or nobody's, and never worth racing for.

An expired grant keeps its name until another grant claims it, so a tenant
whose readable URL stopped working is told the *grant* expired rather than
that the hostname means nothing here.

## Following the workload

Resolution answers *where is this workload?* once. Three things keep that
answer true, and a fourth stops it being asked at all (spec §12.7).

**A Takeover.** For every workload it holds a grant for, this process watches
kind `30433` with `#d` the workload id on the **primary's Relay Set** — the
`relays` of `standby_set[0]`'s Provider Profile, which need not be a relay it
is configured with. A claim that does not verify, or that is signed by a key
the grant's `standby_set` does not name, is ignored.

**The settle window.** A Takeover event does not mean the workload has moved:
it means a standby announced that it *intends* to take it, and spec §7.1 gives
that standby **two of the primary's Liveness cadences**, from its own
announcement, before it starts anything. So nothing is re-asked until
`created_at + 2 × liveness_cadence_s` of the claim — counted from the event,
not from when this process saw it, so a slow relay or a restart does not move
the deadline. Asking earlier would cost every member a `status` and find
nothing running.

**A Liveness cadence.** Independently of any event, the Standby Set is asked
again once per `liveness_cadence_s` while a target is held, because a
self-stop, an expiry and an eviction announce nothing to a gateway. That
re-ask waits while a settle window is running, for the reason above.

**The last known target keeps serving.** While a re-resolution is in flight,
requests keep going to the member last seen running; only a *finished*
resolution moves the target or withdraws it. A slow relay, a slow connector or
a member that will not answer costs the freshness of the answer, never the
service.

Two things stop a workload being served at all, with nothing for an operator
to do: a grant that passes its `expires_at` (`grant_expired`, and the grant is
not carried to a provider afterwards, which would refuse it `bad_grant`), and
a **later grant from the same tenant naming another gateway**. That rotation
names the *other* gateway in its `p` tag, so the one filter of *How a workload
arrives here* cannot carry it; it is found on a second watch, kind `30438`
with `#d` the workload ids held. Because that filter carries events from
anyone, only the **tenant of the grant held** may replace it — otherwise a
stranger could publish a later grant with the same `d` and take any workload
off this gateway.

```
Takeover created_at  ──2 × liveness_cadence_s──▶  ask every member  ──▶  the URL moves
        (the previous target keeps serving all the way across)
```

So: after a Takeover a URL moves about one settle window after the claim was
published, plus up to one `GATEWAY_FOLLOW_TICK_MS`; after a self-stop, an
expiry or an eviction it stops being served within one cadence.

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
| `GATEWAY_RESOLVE_TIMEOUT_MS` | `3000` | How long resolution waits for anything it needs — a member's Profile off a relay, and that member's answer to `status`. Every member is asked at once, so this is the whole of what one slow member costs a tenant's first request. |
| `GATEWAY_FOLLOW_TICK_MS` | `1000` | How often this process looks at the clock while following a workload. It decides **nothing**: a settle window and a Liveness cadence are counted in the grant's and the Profile's own seconds, and this is only how late it may be in noticing that one has passed. Tests set it to tens of milliseconds so a clock they control is noticed at once. |
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

### How `status` is sent — read this before deploying

`status` is a **free** route (spec §5): no payment to make, no claim to attach,
no channel to open. What this process sends is the §6.1.1 packet body —
`{ "request": <event> }` — as a plain `POST` to the `status` path beside the
member's `connector_url`. That is the body a provider reads once its connector
has unsealed the envelope, and the path the wire fixtures record as
`http_path`.

**The limit of that, said plainly.** A connector that terminates
`<addr>.status` expects a *sealed ILP packet* at its client edge, and answers
nothing on a plain `POST`. So this carriage reaches a member whose free
`status` route is served plainly — the provider app itself, or a connector
configured to forward it — and **not** a member reachable only through a
sealed client edge. The spec fixes the *request* and leaves the carriage to
§5 and the member's connector (spec §12.4), so both are gateways; this one has
only the first.

The sealed carriage was not written here because it would **buy nothing** —
the route is free — while pulling a payment client, a channel and a sealing
key into a process whose whole point is that it holds none of them. Adding it
changes exactly one file, [`src/status.mjs`](src/status.mjs), and would read
`connector_seal_key` and `ilp_address` off the Profile that
[`src/profiles.mjs`](src/profiles.mjs) already has: the request, the signature
and the grant are identical either way. What changes is the carriage, not the
request.

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
| `no_running_member` | Every member of the Standby Set answered, and none of them is running it. |
| `member_unreachable` | A member that would answer for the workload cannot be reached — its connector, or the address it gave. |

A request to a hostname with no grant — an unknown label, the bare domain, a
deeper name, or a name under somebody else's domain — **never reaches a
provider or a workload**: nothing is dialled at all.

`no_running_member` and `member_unreachable` are deliberately not one reason:
the first says nothing is running the workload, the second says this gateway
cannot see what may well be running. A tenant acts on them differently.

The vocabulary is one table, `REASONS` in [`src/reasons.mjs`](src/reasons.mjs).
Add a row (or call `defineReason`) and the HTTP status, the JSON body, the
HTML page and the header all follow. M5-6 adds *no proxy configured*.

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
| `src/profiles.mjs` | The Standby Set members' Profiles: connectors, Relay Sets, cadences. |
| `src/resolve.mjs` | Resolution: ask every member, pick the running one, hold the target. |
| `src/follow.mjs` | Following the workload: the Takeover watch, the settle window, the per-cadence re-ask, the rotation watch. |
| `src/status.mjs` | One `status` request: signing it, where it is sent, reading the answer. |
| `src/forward.mjs` | Forwarding: the headers, the answer, and WebSocket upgrades. |
| `src/dial.mjs` | The one place a TCP connection is opened — and the one host it refuses. |
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
resolver answered the request itself. A resolver that throws is logged and
answered `not_resolved`, so a bug here is never a dropped connection. WebSocket
upgrades arrive at the same resolver with `socket` and `head` in place of
`res`.

Left out, `startGateway` builds the real one (`src/resolve.mjs`). It is
returned as `gateway.resolver`, and that is the seam the rest of Milestone 5
works at:

| | |
|---|---|
| `resolver.resolveNow(grant)` | Ask the Standby Set again, now. Concurrent callers join one attempt. |
| `resolver.current(workloadId)` | Where the workload is running, as far as this gateway knows — the *last known target*, which keeps serving while a re-resolution is in flight. |
| `resolver.forget(workloadId)` | Stop serving that target. |
| `gateway.profiles.get(pubkey)` | A member's `connectorUrl`, its `relays` and its `livenessCadenceS`. |
| `gateway.pool.subscribe({…})` | Open another relay subscription. |
| `gateway.follower` | Following the workload: `offer(event)` for a grant event, `start()`, `close()`. |

Spec and ADR references are to `toon-protocol/TOON_Network`:
`docs/spec/toon-network-v1.md` and
`docs/adr/0013-hostnames-and-tls-live-in-a-workload-gateway.md`.

[adr13]: https://github.com/toon-protocol/TOON_Network/blob/main/docs/adr/0013-hostnames-and-tls-live-in-a-workload-gateway.md
[hidden]: https://github.com/toon-protocol/TOON_Network/blob/main/docs/spec/toon-network-v1.md#10-hidden-provider
