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

**It holds no lease, pays for nothing and calls no paid route, and it signs
nothing and publishes nothing.** Its whole authority is the **Gateway Grant**
(spec §6.5.1) — a value derived from the lease's Continuation Token that
admits it to one workload's `status` until a moment the tenant chose, and to
nothing else.

## Run a gateway

**You probably do not need to.** A gateway is optional and separate from
running a provider. A provider needs none, and the devnet's own gateway, at
`*.gw.devnet.toonprotocol.dev`, can already front a workload on any devnet
provider. Run your own to serve workloads under a domain of yours. It serves
only the workloads a tenant hands over to it.

A gateway is four services on one host: this process, its own TOON
connector, nginx and certbot. [`deploy/`](deploy/) runs all four, and
[its README](deploy/README.md) has the detail behind each step below.

**This is the TOON devnet.** The bundle's relay and settlement block is the
devnet preset, which settles in mock USDC on Base Sepolia and Solana devnet
(<https://faucet.devnet.toonprotocol.dev>). A gateway needs none of it: its
one route is free, so it is never paid and never pays.

**You need** an Ubuntu host you are root on, with a public IPv4 and inbound
TCP 22, 80 and 443 (`bootstrap.sh` opens them in ufw, but a cloud firewall is
yours to open). You need a domain in a DNS zone you control, with three
A-records at the box: your gateway domain, a wildcard under it, and an edge
host *beside* it (for example `gw.example.com`, `*.gw.example.com` and
`proxy.gateway.example.com`)
([why two names](deploy/README.md#two-names-and-why-they-are-not-one)). You
need API credentials for that zone at Porkbun or Cloudflare, which certbot
uses to prove the wildcard ([adding another DNS provider is one
file](deploy/README.md#adding-a-dns-provider)). And you need 1–2 devnet SOL
for the connector's Solana settlement key.

1. Clone to `/root/gateway` (the auto-apply unit runs from there), then
   `cd /root/gateway/deploy` and `cp .env.example .env`. In `.env` set an
   `ILP_ADDRESS` of your own such as `g.<your-name>.workload-gateway`, then
   `GATEWAY_DOMAIN`, `EDGE_HOST`, `LETSENCRYPT_EMAIL`, `DNS_PROVIDER` and
   that provider's lines, and `OPERATOR_BEARER_TOKEN` and
   `OPERATOR_WRITE_KEY` as the file describes. Leave the relay and settlement
   block as the devnet preset.
2. Generate the keys: `openssl rand -hex 32 > <file>` for `signer.key`,
   `settlement.key` and `settlement-solana.key`, then `chmod 600 *.key`. Keep
   a copy of `signer.key` off the box. Tenants seal to it, so it *is* your
   gateway.
3. [Fund the Solana settlement key](deploy/README.md#funding) with devnet SOL
   from <https://faucet.solana.com>. The connector will not start without it.
   The EVM key needs nothing to boot.
4. Run `./bootstrap.sh`. It installs Docker, writes the internal
   certificate, renders the config, pulls and starts the four services,
   requests a Let's Encrypt *staging* certificate over DNS-01, and installs
   the timer that keeps the box on `main`.
5. If step 4 printed `Done. STAGING certificate` rather than
   `Certificate issuance failed`, set `LETSENCRYPT_STAGING=0` in `.env` and
   run `./init-letsencrypt.sh` for the real certificate.

Then [check it works](deploy/README.md#checking-it-works):

```bash
curl -i https://anything.<GATEWAY_DOMAIN>/   # 503, toon-gateway-reason: no_grant
curl https://<EDGE_HOST>/ilp/identity        # the sealing key tenants pin
```

`no_grant` is the healthy, empty state: the gateway answered and holds
nothing yet. A tenant uses your gateway by sealing a Gateway Handover to
`<ILP_ADDRESS>.handover` at `https://<EDGE_HOST>/ilp`.

The gateway image is published to GHCR and pinned to a commit, `sha-<short>`,
so the box pulls it and builds nothing
([How updates arrive](deploy/README.md#how-updates-arrive)).

## How a workload arrives here

A tenant seals **one packet** to this gateway's connector: a **Gateway
Handover** (spec §12.1) carrying the workload id, the Standby Set with the
primary first, which of the spawn's ports is the HTTP one, the moment the
grants were derived for, a grant derived for *each* member, and an optional
readable name. Nothing is published, so there is nothing to find on a relay
and nobody holds an account here.

**Admission is empirical, and that is the whole of it.** There is no signature
to check any more, so this gateway checks a handover by **sending `status` to
the members it names** and seeing whether they take the grant. Being sent
something becomes proof precisely because only the holder of the lease's
Continuation Token can derive a grant a provider will accept. It is **one
bounded round, immediately**; a handover the members refuse is logged, the
sender is told, and it is **dropped and never retried**.

```
tenant  ──seal handover──▶  gateway connector  ──plain POST /handover──▶  gateway
                                                                            │
                                     ┌──────── one round of `status` ───────┘
                                     ▼
                         every member the handover names
                                     │  accepted by one of them?
                                     ▼
                serves https://<canonical>.<gateway-domain>/
```

A later handover that admission accepts **replaces** the one held: renewal,
rotation of the grant's moment and a change of Standby Set are all the same
act, and all take effect with no restart. Nothing is weighed to decide which
of two is current, because getting past admission is already the proof.

**Rotation needs nothing of its own here.** A tenant that rotates its lease's
Continuation Tokens (spec §6.8) revokes every grant derived from the old ones,
and the members answer the grant this gateway holds `bad_grant` — which
resolution already counts as a member that told it nothing, so the hostname
answers `503 member_unreachable`. A tenant that keeps the gateway seals a
handover of grants derived from the new tokens, and the ordinary admission
round admits it and replaces what was held.
[`tests/rotation.test.mjs`](tests/rotation.test.mjs) pins both.

### Two consequences, written down rather than discovered

**The amplification is about one to one.** Anyone can seal a handover naming
any provider, so one sealed packet a stranger paid to deliver buys one free
`status` to each member it names. Admission is therefore **rate-limited per
member** (`GATEWAY_ADMIT_PER_MINUTE`) and a handover naming more than 16
members is refused outright: a burst of unsolicited handovers cannot make this
gateway exceed that rate against any one provider, however it is spread across
workloads.

**A gateway cannot allowlist tenants**, and that is a consequence of the design
rather than an oversight. After Milestone 6 there is no tenant identity to put
on a list: nothing is signed, nothing is published, and the sealed envelope is
unauthenticated on purpose (ADR 0011). What can be bounded is the work one
packet buys, which is what the rate limit does.

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
Set. Each member's **Provider Profile** (spec §4.1) gives the three facts that
reach it — `connector_url`, `ilp_address` and `connector_seal_key` — and its
Relay Set: a gateway looks for Profiles on the relays it is configured with,
and then on the relays a Profile itself names, because a provider publishes to
its *own* Relay Set. Every member is then sent `status` (spec §6.5) **at
once**, each request presenting the grant derived for *that* member — nobody
signs anything:

```
handover.standby_set ──▶ seal to Profile(member).connector_seal_key
                         addressed <ilp_address>.status ──▶ connector_url
                         continuation = that member's grant
                                                       ◀── state, access ──
```

The **running member** is the one answering `state: "running"` with `access`.
A member answering `reserved`, `stopped` or an ending is simply not the target
— that is a Warm Standby doing its job, not a failure. A member that *refuses*
(`bad_grant`, `unknown_workload`) is a third thing: it answered, and it told
this gateway nothing about the lease, so it is counted with the members that
could not be reached rather than with the ones that answered. An answer that
is **not a `status` document at all** — a 404 from a hop in front of the
provider app, an HTML error page, an empty body — is counted the same way and
for the stronger reason: the lease was never asked about. Asking all members rather than the primary first is
the point: a Takeover moves a workload with no tenant online to say so, so the
member listed first is exactly the one that may no longer have it.

The **target port** is the `host_port` of the `access.ports` entry whose
`container_port` equals the handover's `http_port`. Not the first port, and
not `ssh_port`: a workload commonly exposes several, the host ports are the
provider's to choose, and `http_port` is in the handover precisely so that
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

## A workload on a Hidden Provider

A Hidden Provider publishes no host: its connector is reachable only at an
`.anyone` address, and so is every lease it runs (spec §10, ADR 0008). A
workload on one gets a public URL here all the same, and its provider stays
hidden, because **this gateway is an ordinary client of the per-lease
`.anyone` address**: it dials one through its anon client — the `socks5h://`
port of a running `anon` daemon, `TOON_SOCKS_PROXY` — and everything else
about resolution and forwarding is unchanged (spec §12.8).

**Both legs go through the proxy, and only for `.anyone` hosts**:

| Host | Dialled |
|---|---|
| A member's `connector_url` at an `.anyone` host | `status` goes through the proxy — the connector client is given it (`src/status.mjs`). |
| A running member's `access.host` that is an `.anyone` name | The request is forwarded through the proxy ([`src/dial.mjs`](src/dial.mjs)). |
| Anything else | Directly, on either leg. |

So a Standby Set mixing a public primary with a hidden standby works with no
configuration beyond the proxy: each member is dialled the way its own
address calls for, and nothing in the handover says which members are hidden.

An `.anyone` name is **never resolved or dialled directly**, under any
circumstances. The name goes to the proxy *as a name* — `socks5h`, under which
the proxy resolves it at the far end of the circuit; plain `socks5`, under
which this process would resolve it first, is refused at startup — and with
**no proxy configured, a workload that needs one is refused with `no_proxy`**
before anything is tried, rather than handed to a system resolver that would
put a hidden service into a plaintext DNS query. That includes a relay a
Profile names at an `.anyone` host: this process reaches relays directly, so
such a relay is **not watched**, and the log says so. A `connector_url` at
`https://` is spoken to over TLS on the circuit, exactly as a public one.

Two things to know before pointing a hidden workload here:

- **A circuit takes time.** Reaching a hidden service means the `anon` daemon
  building a circuit to it, which routinely takes longer than a TCP connect.
  The dial waits up to 120 s for one (the client's own figure), and
  `GATEWAY_RESOLVE_TIMEOUT_MS` does not shorten that: it bounds the wait for
  a member's *answer* once connected, not for the circuit. A hidden member's
  first resolution is slower than a public one's; the target is kept
  afterwards, so only the first request pays.
- **What fronting one discloses.** This gateway reads every request it
  fronts, hidden or not. Fronting a Hidden Provider's workload reveals **the
  workload's existence and its traffic pattern — not the provider's
  location**: the gateway is one more client of the per-lease address, and
  learns nothing about where the provider is that the tenant's own client
  would not (spec §12.8, ADR 0008). The tenant makes that choice by handing
  the workload to a gateway.

## A readable name

A handover may also carry a `name`. It is served at `<name>.<GATEWAY_DOMAIN>`
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
is configured with. That watch, and the members' Profiles, are the **only**
things this gateway reads a relay for on a workload's account. A claim that
does not verify, or that is signed by a key the handover's `standby_set` does
not name, is ignored. Where several members
claim the same workload, the **earliest** claim decides, as it does for the
standbys themselves: a later claimant can only bring the deadline forward,
never push it out.

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
self-stop, an expiry and an eviction announce nothing to a gateway. A primary
whose Profile states no `liveness_cadence_s` — a defective Profile, spec §4.1
requires one — is followed at an assumed 60 s rather than not followed: that
is the provider's doing, and the tenant would pay for it. The re-ask waits
while a settle window is running, for the reason above, and no longer than the
window itself.

**The last known target keeps serving.** While a re-resolution is in flight,
requests keep going to the member last seen running; only a *finished*
resolution moves the target or withdraws it. So a slow relay, a slow connector
or a member that is taking its time costs the freshness of the answer and not
the service — for as long as the resolution is in flight. A resolution that
finished and learned nothing does withdraw the target, and says which of the
two reasons it was.

**A grant that runs out** stops a workload being served, with nothing for an
operator to do: at `now > expires_at` the hostname answers `grant_expired`,
and the grant is not carried to a provider afterwards, which would refuse it
`bad_grant` and rightly. Expiry is a comparison made when a request arrives,
so a tenant that hands over a grant derived for a later moment is served again
by that same act.

**A Gateway Withdrawal** takes a workload off this gateway *before* its grant
runs out; it is the section below.

```
Takeover created_at  ──2 × liveness_cadence_s──▶  ask every member  ──▶  the URL moves
        (the previous target keeps serving all the way across)
```

So: after a Takeover a URL moves about one settle window after the claim was
published, plus up to one `GATEWAY_FOLLOW_TICK_MS`; after a self-stop, an
expiry or an eviction it stops being served within one cadence.

## Taking a workload off this gateway

A tenant seals a **Gateway Withdrawal** (spec §12.7) to the same route the
handover went to, and this process stops serving that workload **at once**:

```json
{ "withdrawal": {
    "workload_id": "…",
    "expires_at":  1700086400,
    "standby_set": [ { "provider": "<pubkey>", "grant": "<32 bytes, hex>" }, … ]
} }
```

The members are spelled exactly as a handover spells them, because they are
the same fact. `expires_at` says **which grant** the withdrawal bears — the
moment the handover named — and it is **not** compared with the clock: a
withdrawal of a grant that has already run out still frees the names that
grant is still holding.

**Bearing the grant is what makes it safe without a signature.** Nothing a
tenant produces is signed any more, so this process cannot ask who sent a
withdrawal. It asks something else, which is enough: a withdrawal must bear
the grant this gateway is reading the lease with, and **only the holder of the
lease's Continuation Token can derive that value**. The only other party that
holds it is this gateway, whose withdrawing itself costs nobody anything. So
a stranger cannot take any workload off any gateway, and a withdrawal bearing
a wrong, stale or absent grant is **ignored and logged** — the workload goes
on being served. The comparison is constant time, and a withdrawal for a
workload this process does not hold reaches nobody at all: no provider is
dialled and no relay is read to answer one.

**A withdrawal ends serving, not reading.** The withdrawn gateway keeps a
**working grant** until its `expires_at` and could still ask a provider for
`status` with it — a withdrawal revokes nothing, and nothing here claims
otherwise. What ends, at once, is this process serving the
workload: it stops forwarding it, stops following it, and gives up its
readable name for the next grant that asks for it. An *expired* grant, by
contrast, keeps its name until another claims it, so a tenant whose readable
URL stopped working is told the grant expired rather than that the hostname
means nothing here.

| Answer | Means |
|---|---|
| `200 { workload_id, hostname, withdrawn: true }` | That hostname is no longer served here. The grant is untouched. |
| `invalid_withdrawal` | It is not a withdrawal: a field no withdrawal names, or one of them malformed. |
| `not_withdrawn` | This gateway is not serving that workload under the grant borne — a wrong or stale grant, or a workload it never held. Nothing changed and nobody was asked. |
| `withdrawal_failed` | This process could not carry one out at all. Nothing was decided, and the workload may still be served here. |

## Configuration

Environment only; there is no config file.

| Variable | Default | Meaning |
|---|---|---|
| `GATEWAY_DOMAIN` | — | **Required.** Every workload is served at `<canonical label>.<domain>`. Point a wildcard `*.<domain>` at this process. |
| `GATEWAY_RELAYS` | — | **Required.** Comma-separated `ws://`/`wss://` relays, where this process looks for the Provider Profiles of the members a handover names and for the Takeovers that move a workload between them. |
| `GATEWAY_HANDOVER_PORT` | — | **Required.** Where this gateway's connector forwards a sealed Gateway Handover — and a sealed Gateway Withdrawal, which rides the same route — and the only way a tenant can tell this process to serve a workload or to stop. Its **own** listener, never a path on the ones that front workloads, because a reserved path would carve a hole out of every tenant's URL space. It should not be reachable from outside the connector. |
| `GATEWAY_TLS_CERT` / `GATEWAY_TLS_KEY` | — | Paths to the certificate and key for `*.<GATEWAY_DOMAIN>`. Required unless `GATEWAY_HTTP_PORT` is set. |
| `GATEWAY_HTTPS_PORT` | `443` | Where TLS is terminated. |
| `GATEWAY_HTTP_PORT` | — | A plain-HTTP listener, for development or for a deployment terminating TLS in front. Set it or the certificate pair, or this process refuses to start. |
| `GATEWAY_BIND_ADDR` | `0.0.0.0` | What to listen on. |
| `GATEWAY_RESOLVE_TIMEOUT_MS` | `3000` | How long resolution waits for anything it needs — a member's Profile off a relay, and that member's answer to `status`. Every member is asked at once, so this is what one slow member costs a tenant's first request — plus, for a hidden member, the circuit build, which is bounded separately (see [A workload on a Hidden Provider](#a-workload-on-a-hidden-provider)). |
| `GATEWAY_FOLLOW_TICK_MS` | `1000` | How often this process looks at the clock while following a workload. It decides **nothing**: a settle window and a Liveness cadence are counted in the grant's and the Profile's own seconds, and this is only how late it may be in noticing that one has passed. Tests set it to tens of milliseconds so a clock they control is noticed at once. |
| `GATEWAY_ADMIT_PER_MINUTE` | `6` | How many admission rounds any one provider may be asked for in a minute. Anyone can seal a handover naming any provider, so this is what stops a burst of unsolicited handovers making a reflector of this process; a handover naming a member that is over its rate is refused whole, and nothing is asked. |
| `TOON_SOCKS_PROXY` | — | `socks5h://<host>:<port>`: the SOCKS5 port of a running `anon` daemon, through which every `.anyone` host is dialled. Without it, a workload on a Hidden Provider is refused with `no_proxy`. The scheme must be `socks5h`: under plain `socks5` this process would resolve the destination itself, putting a hidden service into a plaintext DNS query. |
| `GATEWAY_DIAL_REWRITE` | `{}` | **Development only.** A JSON map from an advertised `host` or `host:port` to the `host` or `host:port` this process dials instead — a member's `connector_url` and the `access.host` it answers name the member as *its* clients reach it, and on a compose network that is not where this container reaches it. The forwarding leg applies it at the dial seam and the `status` leg to the connector's URL, so the two agree; it moves the socket and rewrites no header, no destination and no sealing key. The sandbox's value is in `infra/sandbox/conf/workload-gateway.conf`. Empty in production, where the advertised address is the real one. |

Startup collects **every** missing or malformed key and refuses with all of
them at once:

```
[gateway] this Workload Gateway cannot start:
  - GATEWAY_DOMAIN is required: every workload is served at <canonical label>.<domain>.
  - GATEWAY_HANDOVER_PORT is required: it is where this gateway's connector forwards …
  - this gateway has nothing to front a workload on: set GATEWAY_TLS_CERT and GATEWAY_TLS_KEY …
```

A half-configured gateway is worse than one that will not start: it answers a
tenant's hostname with nothing, and nothing is exactly what a stopped workload
and a broken gateway look like from outside.

## Its own connector

ADR 0013 puts a gateway behind its own connector, like any other TOON app, and
[`deploy/`](deploy/) runs it: `connector` in
[`docker-compose.yml`](deploy/docker-compose.yml), configured by
[`connector.toml.template`](deploy/connector.toml.template), which `render.sh`
fills from `.env`.

That connector terminates **one route**, `<ILP_ADDRESS>.handover`. A Gateway
Handover and a Gateway Withdrawal both ride it, and it forwards both to this
process's `GATEWAY_HANDOVER_PORT` (8081). The door is published on no host
port, so a sealed packet through the connector is the only way a tenant can
tell this process what to serve or stop serving.

**Its signer key is this gateway's identity.** A tenant seals the handover to
the public half of `signer.key`, which the connector answers at
`GET /ilp/identity`. The gateway process holds no key at all, so as far as a
tenant is concerned that key *is* the gateway. Replacing it makes this a
different gateway, and every grant already handed over stops being
addressable.

**The route is free.** It is priced `0`, so nothing a tenant asks this process
for is sold, and this process buys nothing either: it holds no payment
channel, no mnemonic and no lease, and it never calls a paid route. The
connector still carries two settlement keys, for the tenant's sake: a
connector client opens its channel against the settlement key the payee's
`GET /ilp` reports, so a node with no settlement table has nothing to open one
against. The Solana key needs a little SOL to boot
([Funding](deploy/README.md#funding)).

nginx fronts the connector at `EDGE_HOST` and the gateway at every name under
`GATEWAY_DOMAIN`. The connector's own port is bound to the loopback only.
[`deploy/README.md`](deploy/README.md) covers the rest: the pin, the operator
surface and the exposure rules.

### How `status` is sent — read this before deploying

`status` is a **free** route (spec §5): no payment to make, no claim to attach,
no channel to open. What a member must RECEIVE is the §6.1.2 packet body —
`{ "request": <request> }`, a plain JSON object nobody signed, carrying the
member's grant as its `continuation` and the moment it was derived for as its
content's `gateway_expires_at`. What this process SENDS is that body inside a
**sealed ILP packet**, exactly as every other client of that route sends one:
addressed `<ilp_address>.status`, posted to `connector_url`, sealed to
`connector_seal_key` — the three fields the member's own Provider Profile
publishes, so nothing is guessed and no path is invented beside a URL. The
member's connector unseals the envelope and forwards plain HTTP to the
provider app, which reads the body as plaintext JSON and no payment header.

The **sealed messages a tenant sends this gateway** arrive the same way from
the other side: the gateway's own connector unseals the envelope and forwards
plain HTTP to `GATEWAY_HANDOVER_PORT`, so this process reads plaintext JSON
and holds no sealing key of its own. A handover and a withdrawal are sealed to
the one route that connector terminates, so both arrive at that one path, and
the body's single key — `handover` or `withdrawal` — is what says which.

**This gateway still holds no money.** `<addr>.status` is priced at `0`, and a
free route needs no claim: the sender identity is generated fresh at startup,
written to no store, never funded and holding no channel, and the client is
built with `autoOpenChannel` off — so a paid route cannot be paid for here
even by mistake. The key exists because a sealed packet needs an ephemeral
sender, not because anything is bought with it. Nothing on any chain moves on
this gateway's account, and a member's books show the same figure after a
thousand `status` calls as before the first.

**Why not a path beside `connector_url`.** An earlier round of this gateway
replaced the `/ilp` suffix of `connector_url` with `/status` and sent plain
HTTP there. That URL is nowhere in the directory: `connector_url` is the
connector's own client edge (spec §4.1), and behind it the provider app's one
listener carries `/status` *and* every `<listing>.v<n>.spawn` handler — so a
deployment that exposed it would be putting a paid route on the public
internet with the payment skipped. Real deployments therefore `404` it, and a
`404` is not an answer about a lease. That is how every handover to a
connector-fronted provider came to be answered `no_running_member`
(TOON_Network#114). Spec §12.4 leaves the carriage to §5 and the member's
connector; the only carriage the directory actually describes is this one.

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
| `grant_expired` | The grant ran out. Handing over one derived for a later moment renews it, with no restart. |
| `not_resolved` | A grant is held, but where the workload runs is not known yet. |
| `no_running_member` | Every member of the Standby Set answered, and none of them is running it. |
| `member_unreachable` | A member that would answer for the workload cannot be reached — its connector, or the address it gave. |
| `no_proxy` | The workload is on a Hidden Provider — its connector or its lease is at an `.anyone` address — and this gateway has no `TOON_SOCKS_PROXY` to reach one through. Nothing was tried. |

A request to a hostname with no grant — an unknown label, the bare domain, a
deeper name, or a name under somebody else's domain — **never reaches a
provider or a workload and reads no relay on its account**: nothing is dialled
at all. A gateway is not a probe, and an unknown hostname must not become one.

Admission answers its own refusals, at the handover port and in the same
`{ "error", "message" }` shape: `invalid_handover` (it is not a handover),
`grant_expired` (its moment has passed, so nothing was asked), `rate_limited`
(a provider it names is over its admission rate, so nothing was asked),
`not_admitted` (the round was made and no member took the grant; the handover
was dropped), `no_proxy` (a member it names is at an `.anyone` address this
gateway has no anon client for, so nothing was dialled) and `admission_failed`
(this gateway could not make a round at all). The last three are deliberately
not one code: only `not_admitted` is a reason to go and derive another grant.
A handover it admitted is answered `{ "workload_id", "hostname", "expires_at" }`.

`no_running_member` and `member_unreachable` are deliberately not one reason:
the first says nothing is running the workload, the second says this gateway
cannot see what may well be running. A tenant acts on them differently.

`no_proxy` is likewise its own reason and not `member_unreachable`: the first
is a fact about this gateway's configuration, which its operator fixes, and
the second is a fact about its reach.

The vocabulary is one table, `REASONS` in [`src/reasons.mjs`](src/reasons.mjs).
Add a row (or call `defineReason`) and the HTTP status, the JSON body, the
HTML page and the header all follow.

## What is here

| File | What it is |
|---|---|
| `src/main.mjs` | The process: read the environment, refuse or start, handle signals. |
| `src/config.mjs` | The configuration, and the refusal naming everything missing. |
| `src/gateway.mjs` | The composition: listeners, the tenant's door, `stop()`. |
| `src/serve.mjs` | The request path: hostname → grant → the resolver seam, and the refusals. |
| `src/door.mjs` | The tenant's door: the listener both sealed messages arrive at, and which of the two this body is. |
| `src/admit.mjs` | Admission: the rate limit, and the one bounded round a handover is admitted on. |
| `src/withdraw.mjs` | Withdrawal: the grant a withdrawal must bear, compared in constant time, and what it ends. |
| `src/grants.mjs` | The grants held: one per workload, replacement, release, the hostname index. |
| `src/messages.mjs` | Reading a Gateway Handover or a Gateway Withdrawal, or saying which field is wrong. |
| `src/relays.mjs` | The relay pool: subscriptions that stay open. |
| `src/profiles.mjs` | The Standby Set members' Profiles: connectors, Relay Sets, cadences. |
| `src/resolve.mjs` | Resolution: ask every member, pick the running one, hold the target. |
| `src/follow.mjs` | Following the workload: the Takeover watch, the settle window, the per-cadence re-ask. |
| `src/status.mjs` | One `status` request: building it, sealing it through the member's connector, reading the answer. |
| `src/forward.mjs` | Forwarding: the headers, the answer, and WebSocket upgrades. |
| `src/dial.mjs` | The one place a TCP connection is opened: `.anyone` through the proxy, anything else directly, and the `no_proxy` refusal. |
| `src/rewrite.mjs` | `GATEWAY_DIAL_REWRITE`: an advertised address dialled somewhere else, in front of that seam. |
| `src/hostname.mjs` | The canonical label: base32, and reading a label out of a `Host`. |
| `src/nostr.mjs` | NIP-01, the reading half: serialize, id, verify. This gateway signs nothing. |
| `src/reasons.mjs` | The `503` vocabulary. |
| `src/kinds.mjs` | The kind numbers, pinned to the provider's fixtures by a test. |

## Development

### Running it from source

This is for working on the gateway itself. A box runs the published image
through [`deploy/`](deploy/) instead: see [Run a gateway](#run-a-gateway).

```sh
npm install

# development: a plain listener, no certificate
GATEWAY_DOMAIN=gw.localhost \
GATEWAY_RELAYS=ws://localhost:7100 \
GATEWAY_HANDOVER_PORT=8081 \
GATEWAY_HTTP_PORT=8080 \
npm start

# production: TLS for *.gw.example
GATEWAY_DOMAIN=gw.example \
GATEWAY_RELAYS=wss://relay.one,wss://relay.two \
GATEWAY_HANDOVER_PORT=8081 \
GATEWAY_BIND_ADDR=0.0.0.0 \
GATEWAY_TLS_CERT=/etc/tls/fullchain.pem \
GATEWAY_TLS_KEY=/etc/tls/privkey.pem \
npm start

# fronting Hidden Providers too: .anyone hosts go through a running anon daemon
TOON_SOCKS_PROXY=socks5h://127.0.0.1:9050 \
GATEWAY_DOMAIN=gw.example \
GATEWAY_RELAYS=wss://relay.one \
GATEWAY_HANDOVER_PORT=8081 \
GATEWAY_TLS_CERT=/etc/tls/fullchain.pem \
GATEWAY_TLS_KEY=/etc/tls/privkey.pem \
npm start
```

TLS is terminated here, for **this** gateway's domain, with **this** gateway's
certificate — which is the point: a workload is reachable over HTTPS while
holding no certificate itself, and no provider in the Standby Set ever sees a
certificate key.

### In a container

`Dockerfile` builds it: `docker build -t toon-workload-gateway .`, then the
same environment, with the certificate pair mounted wherever
`GATEWAY_TLS_CERT` / `GATEWAY_TLS_KEY` point. The TOON sandbox
(`infra/sandbox`, profile `gateway`) runs it this way behind its own
connector, with a self-signed wildcard certificate and the plain listener
beside it, and its README walks from `make up-gateway` through handing over a
grant to a `curl` of a workload's canonical URL.

### Tests

```sh
npm test        # node --test
npm run typecheck
```

Everything is driven **at the gateway's own listening port**, in process,
against a stub relay, stub provider connectors and stub workloads. Nothing
asserts on what the gateway holds internally — a test written that way passes
when the gateway is broken in exactly the way that matters. The exceptions
are the pure seams with a table or a contract of their own (`reasons`,
`config`, `dial`), and one deliberate look *outside* the gateway:
`hidden.test.mjs` watches the process's `dns.lookup`, because "no `.anyone`
name was ever resolved" is a fact about what left this process, not about
what the gateway answered.

[`tests/harness.test.mjs`](tests/harness.test.mjs) is the smallest working
example of each piece; read it first.

```js
const gateway = await startTestGateway({
  events: [providerProfile({ connectorUrl })],   // what the relay already holds
  handovers: [gatewayHandover({ workloadId })],  // POSTed at the handover port
  probe: admitAll,                               // the admission seam
  resolve: myResolver,                           // the resolver seam
});
t.after(() => gateway.close());

const answered = await gateway.get(gateway.hostFor(workloadId), { path: '/orders' });
await gateway.handover(gatewayHandover({ workloadId, name: 'shop' }));  // mid-test
gateway.publish(takeover({ workloadId }));   // mid-test, into the relay it watches
```

A test about something **downstream of admission** passes `probe: admitAll`
and gets a handover admitted with no member asked, exactly as one about
something downstream of resolution passes its own `resolve`.
[`tests/admission.test.mjs`](tests/admission.test.mjs) is where the real round
is driven, against a stub member that checks a presented grant the way spec
§6.5.1 has a provider check one.

| Helper | Gives you |
|---|---|
| `tests/helpers/harness.mjs` | `startTestGateway`, `gateway.get(host)`, `gateway.handover(body)`, `gateway.withdraw(body)`, `gateway.publish(event)`, `admitAll`, `hostFor`, `untilServed`, `untilReason`, `until`. |
| `tests/helpers/handover.mjs` | `gatewayHandover`, `gatewayWithdrawal` and the tenant's two HKDFs (`continuationFor`, `gatewaySub`, `grantFrom`), plus `asProvider` — a member that checks a presented grant the way a provider does. |
| `tests/helpers/stub-relay.mjs` | A NIP-01 relay: holds Profiles and Takeover events; `publish` reaches subscriptions already open; replaces replaceable events as a relay does. |
| `tests/helpers/stub-connector.mjs` | A provider's connector, terminating a sealed packet for real and answering `status` behind it (spec §5, §6.5). `answerWith` to change the answer, `goSilent` for a member that never replies, `edgeAnswers` to stand in a hop that is not a connector at all, `requests` for what it was asked and what grant it presented. |
| `tests/helpers/stub-workload.mjs` | The tenant's application: records method, URL, headers, body and who connected, and echoes over WebSocket. |
| `tests/helpers/stub-socks.mjs` | A SOCKS5 proxy standing in for the `anon` daemon: routes a name to a stub, records every destination it was asked for and where each onward connection left from — so a test can say every `.anyone` connection went through it and nothing came any other way. |
| `tests/helpers/events.mjs` | Signed `providerProfile`, `takeover`, `liveness`, and `CONSTANTS` — the test-only keys and clock every wire fixture was generated in. |
| `tests/helpers/sign.mjs` | `signEvent` and `publicKeyOf`: the signing half of NIP-01, which only the tests need. |

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
returned as `gateway.resolver`, and that is the seam following and admission
work at:

| | |
|---|---|
| `resolver.resolveNow(grant)` | Ask the Standby Set again, now. Concurrent callers join one attempt. |
| `resolver.probe(handover)` | One bounded round for admission: it records nothing, and joins no attempt already running, so a handover this gateway has not accepted can neither ride on a round started for the grant it holds nor drop a served workload's target by failing. |
| `resolver.current(workloadId)` | Where the workload is running, as far as this gateway knows — the *last known target*, which keeps serving while a re-resolution is in flight. |
| `resolver.forget(workloadId)` | Stop serving that target. |
| `gateway.profiles.get(pubkey)` | A member's `connectorUrl`, its `relays` and its `livenessCadenceS`. |
| `gateway.pool.subscribe({…})` | Open another relay subscription. |

Spec and ADR references are to `toon-protocol/TOON_Network`:
`docs/spec/toon-network-v1.md` and
`docs/adr/0013-hostnames-and-tls-live-in-a-workload-gateway.md`.

[adr13]: https://github.com/toon-protocol/TOON_Network/blob/main/docs/adr/0013-hostnames-and-tls-live-in-a-workload-gateway.md
[hidden]: https://github.com/toon-protocol/TOON_Network/blob/main/docs/spec/toon-network-v1.md#10-hidden-provider
