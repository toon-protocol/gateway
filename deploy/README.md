# The Workload Gateway box

One host, four containers, one wildcard certificate.

```
                       ┌─────────────────────────────────────────────┐
  tenant ──seal──▶ 443 │ nginx ──▶ connector :4000 ──▶ gateway :8081  │  /handover
                       │                                    │        │
  visitor ───────▶ 443 │ nginx ────────────────────▶ gateway :8443    │
                       └────────────────────────────────────┼────────┘
                                                            ▼
                                            the workload, on its provider
```

* `nginx` — the public TLS edge. The only container bound to a public port.
* `certbot` — issues and renews **one** certificate, over **DNS-01**.
* `gateway` — this repository, as the image `publish-gateway-image.yml`
  publishes to GHCR, pulled by an immutable pin.
* `connector` — the gateway's own payment proxy (ADR 0013). It unseals a
  Gateway Handover and forwards it to the gateway's door.

| File | What it is |
|---|---|
| `docker-compose.yml` | The four services. The connector's pin lives here and nowhere else. |
| `docker-compose.shared-edge.yml` | Overlay, off by default (`COMPOSE_FILE` in `.env`): disables `nginx`/`certbot` and joins `gateway`/`connector` to this node's own `edge-gateway` network. § "Running behind the shared edge". |
| `connector.toml.template` | The connector's whole configuration. Rendered; names key paths, holds no secret. |
| `nginx/node.conf.template` | The two server blocks. Rendered. |
| `certbot/<provider>.py` | The DNS-01 auth and cleanup hooks, one file per DNS provider: `porkbun.py`, `cloudflare.py`. No plugin, no image of our own. |
| `render.sh` | Renders the above from `.env`, and refuses a `.env` that would render something wrong. Idempotent. |
| `keys.sh` + `keys.py` | Generates every missing key and prints every address to fund, before anything boots. Needs only `python3`. |
| `bootstrap.sh` | Fresh host → running box. Idempotent. |
| `pull-images.sh` | Gets the pinned images onto the box: pulls them, or builds the gateway from the checkout while its pin is still the `sha-0000000` placeholder. |
| `init-letsencrypt.sh` | Issues or reuses the certificate. Idempotent. |
| `auto-apply.sh` + the two units | The box half of GitOps: follow the branch, apply what merged. |
| `.env.example` | Every variable, with what it is and how to generate it. |
| `bundle.test.mjs`, `render.test.mjs`, `dns01.test.mjs`, `pull-images.test.mjs`, `keys.test.mjs`, `auto-apply.test.mjs`, `init-letsencrypt.test.mjs`, `shared-edge.test.mjs` | The guard: the real files above, `render.sh`/`auto-apply.sh`/`init-letsencrypt.sh` run for real against stubbed `docker`, the DNS hooks against a stub API, `pull-images.sh` against a stub `docker`, `keys.sh`'s addresses against the connector's own derivation, and the shared-edge overlay merged by a real `docker compose config` (needs `docker compose` on the machine running the suite; skips itself otherwise). `npm run test:deploy`. |
| `testdata/` | What the devnet box rendered before its values moved to `.env`; `render.test.mjs` holds the devnet preset to it byte for byte. |

`.env`, the rendered `connector.toml`, `operator-bearer.token`,
`operator-write.keys`, `dns-01.env`, `nginx/conf.d/`, `tls/` and all key
material are gitignored. **Only templates are committed, and an operator edits
none of them**: everything that makes a box yours is in `.env`.

## Two names, and why they are not one

The gateway serves **every single label** under `GATEWAY_DOMAIN`. A handed-over
workload lives at `<canonical label>.<domain>`, where the label is the
lowercase unpadded base32 of the 32-byte workload id — 52 characters nobody
chose — or at an optional readable `name` the handover asked for.

So a name taken under that domain for anything else is a name a tenant can
never be handed. The ILP edge therefore sits **beside** the domain, not inside
it, and `render.sh` refuses a configuration where it does not:

```
GATEWAY_DOMAIN=gw.devnet.toonprotocol.dev          # *.<this> is every workload
EDGE_HOST=proxy.gateway.devnet.toonprotocol.dev    # where a handover is paid for
```

Three A-records, all pointing at the box:

```
gw.devnet.toonprotocol.dev          A  <box ip>
*.gw.devnet.toonprotocol.dev        A  <box ip>
proxy.gateway.devnet.toonprotocol.dev  A  <box ip>
```

## DNS-01, alone in the fleet

Every other bundle here (store, relay, gas-station) validates over HTTP-01,
because every other box knows its own hostnames. This one cannot: the names it
serves are decided by tenants after the certificate was issued. Let's Encrypt
issues a wildcard over **DNS-01 only**, so `certbot` here writes a TXT record
in the zone instead of serving a file.

It does that with a **hook**: a small script under `certbot/`, in plain
`python3`, which the stock `certbot/certbot` image already has. No plugin is
baked in and no image of our own is published, pinned or rebuilt for a few
HTTP requests. `DNS_PROVIDER` in `.env` picks the hook, and two ship:

| `DNS_PROVIDER` | Hook | Its lines in `.env` |
|---|---|---|
| `porkbun` | `certbot/porkbun.py` | `PORKBUN_ZONE`, `PORKBUN_API_KEY`, `PORKBUN_SECRET_KEY` |
| `cloudflare` | `certbot/cloudflare.py` | `CLOUDFLARE_ZONE`, `CLOUDFLARE_API_TOKEN` (an API token from the "Edit zone DNS" template, scoped to the zone), optionally `CLOUDFLARE_ZONE_ID` |

The zone is always the **registered** domain: `gw.example.com` is not a zone,
`example.com` is. DNS does **not** have to point at the box before the
certificate is issued — DNS-01 proves control of the zone, not of the host.

certbot records the hook commands in the lineage's renewal configuration, so
the unattended `certbot renew` loop renews the wildcard exactly the way it was
issued. If you change `DNS_PROVIDER` later, re-run `./render.sh`,
`docker compose up -d certbot` and `./init-letsencrypt.sh`: it sees the
lineage still names the old hook and re-issues it with the new one, rather
than leaving a renewal to fail two months later.

### Adding a DNS provider

A new provider is **one new file**, `certbot/<name>.py`, plus its lines in
your `.env`. Nothing in `render.sh`, `init-letsencrypt.sh` or
`docker-compose.yml` names a provider, so none of them changes. The interface
is fixed:

* **Invoked as** `python3 /opt/hooks/<name>.py auth` and
  `python3 /opt/hooks/<name>.py cleanup`, inside the stock `certbot/certbot`
  image. Standard library only — there is nothing to install into.
* **certbot supplies** `CERTBOT_DOMAIN` (the base name, never the `*.` form)
  and `CERTBOT_VALIDATION` (the value to publish).
* **Its credentials** are variables named `<NAME>_*` — the file name upper
  cased, `-` as `_`. `render.sh` copies exactly those lines of `.env`, and
  `DNS_PROVIDER`, into `dns-01.env` (0600, gitignored), which is the certbot
  container's whole environment from `.env`. It never sees the operator bearer
  token.
* **`auth`** publishes a TXT record at `_acme-challenge.$CERTBOT_DOMAIN`, waits
  until public DNS answers with it, and exits 0; it exits non-zero, naming the
  call that failed, if it cannot publish. It remembers the record's id under
  `/etc/letsencrypt/<name>-dns01/`: a certificate for `x` and `*.x` runs `auth`
  twice for **one** record name, and both tokens must be live at once.
* **`cleanup`** deletes exactly the records its `auth` created, by id, and
  treats "nothing recorded" as nothing to do — certbot runs it after a failed
  `auth` too.
* **It never prints a credential**, including inside an exception's text.
* **It imports nothing from another hook.** certbot stores the command in the
  renewal configuration for the life of the lineage, so each hook must keep
  working on its own.

`porkbun.py` and `cloudflare.py` are both complete examples, and
`dns01.test.mjs` shows how to test one against a stub of the provider's API
without touching a real zone.

## The internal TLS hop

`nginx` proxies workload traffic to the gateway over **HTTPS**, with a
long-lived self-signed certificate `bootstrap.sh` writes to `tls/`.

That looks like belt-and-braces and is not. The gateway computes the
`X-Forwarded-Proto` it hands a workload **from its own listener**, not from a
header. Behind a plain-HTTP hop it would tell every workload `http` while the
visitor was on `https`, and a workload that builds absolute URLs would send
people to a URL that redirects straight back to it.

Keeping the public certificate with nginx also means a renewal never restarts
the gateway — and **every grant this gateway holds is in memory**. A restart
drops them all, and each tenant has to re-seal its handover. A certificate
renewal must not be able to cause that.

The self-signed certificate is presented only to nginx, on this host's compose
network, which does not verify it. It is issued for twenty years on purpose:
expiring it would be a scheduled outage bought for nothing.

## Running behind the shared edge

The devnet is moving onto one Linode, where the relay, store, gas station,
this gateway and the faucet all share one host behind one Caddy that owns 80
and 443 (toon-protocol/infra#24, infra ADR 0001). Every node keeps its own
connector, keys and hostnames — only its own TLS front goes away. For this
box, that is `docker-compose.shared-edge.yml`, an **overlay**, turned on by
two lines in `.env` (never edit the overlay file itself):

```
SHARED_EDGE=1
COMPOSE_FILE=docker-compose.yml:docker-compose.shared-edge.yml
```

`render.sh` refuses a `.env` where the two disagree. **The default is
unchanged**: a `.env` with no `COMPOSE_FILE` line runs `docker-compose.yml`
alone, exactly as this bundle always has.

The overlay disables `nginx` and `certbot` (`profiles: [disabled]` — nothing
here ever sets `COMPOSE_PROFILES=disabled`, so they never start and bind no
host port), gives every service a `mem_limit`, and joins `gateway` and
`connector` to an external Docker network named `edge-gateway` — this node's
own, created and owned by the host's edge (toon-protocol/infra#24), not by
this bundle — under stable aliases:

| Alias | Container:port | What it serves | Scheme |
|---|---|---|---|
| `gateway-gw` | `gateway:8443` | `gw.devnet.toonprotocol.dev`, `*.gw.devnet.toonprotocol.dev` | HTTPS, self-signed (the internal certificate above) |
| `gateway-proxy` | `connector:4000` | `proxy.gateway.devnet.toonprotocol.dev` | plain HTTP |

This is exactly what this box's own `nginx` proxies to today
(`nginx/node.conf.template`), so the host's edge has to replicate the same
handful of things nginx does beyond a plain proxy, or something regresses
silently:

* **`gateway-gw` is HTTPS, not HTTP**, and must stay that way. The gateway
  decides the `X-Forwarded-Proto` it hands a workload from *which of its own
  listeners* the connection arrived on, not from a header (see "The internal
  TLS hop" above) — a plain-HTTP hop here would tell every workload `http`
  while the visitor was on `https`. Dial it with certificate verification
  off and SNI set to the upstream name (nginx: `proxy_ssl_verify off`,
  `proxy_ssl_server_name on`, `proxy_ssl_name $upstream`) — the peer is a
  long-lived self-signed certificate on a private network, with nothing to
  verify it against.
* **`X-Forwarded-Proto: https`** on both upstreams. The gateway does not read
  this header for its own proto decision (above), but the connector's
  advertised endpoints and anything else downstream that does read forwarded
  headers must keep seeing it.
* **`Host` passed through unchanged** (`proxy_set_header Host $host;`). The
  gateway keys every workload off `Host`; rewriting it would make every
  workload see the edge's idea of its own name instead of the one the visitor
  typed.
* **The `no_grant` 503 must reach the client unchanged.** A hostname this
  gateway holds no grant for answers `503` with header
  `toon-gateway-reason: no_grant` — the healthy, empty state
  (`docs/devnet.md`) — and this is a plain response header, not anything
  hop-specific; the edge must not strip or rewrite it.
* **WebSocket upgrades** (`Upgrade`, `Connection`) on both upstreams — a
  workload is an arbitrary HTTP app.
* **Generous timeouts and body sizes** on `gateway-gw`: nginx's
  `proxy_read_timeout`/`proxy_send_timeout 1h` and
  `client_max_body_size 64m`, because a workload can be a long poll or an
  upload. `gateway-proxy` (the sealed ILP edge) uses `proxy_read_timeout 1h`
  and `client_max_body_size 1m` — the handover payload is small.
* **`gateway-proxy` never gets a bare `Host` route.** It answers exactly the
  one name (`proxy.gateway.devnet.toonprotocol.dev`, `EDGE_HOST`); `location
  ^~ /admin { return 404; }` is nginx's own belt-and-braces, worth keeping on
  the edge too.

**Resolved: only the edge shares a network with this gateway.** Joining
`gateway` to a network every other node's containers also sat on would have
made *every* port it listens on reachable to any of them — Docker gives no
per-port ACL between containers sharing a bridge network, and `expose:` in
`docker-compose.yml` is documentation, not enforcement. That would have
included `GATEWAY_HANDOVER_PORT` (8081), which "Privacy and exposure
invariants" below is explicit must be reachable from nowhere but `connector`:
reaching it directly would let someone tell this gateway what to serve
without paying its connector a packet. So there is no flat `edge` network —
`edge-gateway` is this node's own, named and owned by the host's edge
(toon-protocol/infra#24) same as the other four nodes each get their own
(`edge-relay`, `edge-store`, `edge-gas`, `edge-faucet`); the edge's Caddy
joins all five, but no node's containers ever sit on another node's network.

`connector`'s existing loopback publish (`127.0.0.1:4000`) is untouched:
`bootstrap.sh` and `auto-apply.sh` still read `GET /ilp/identity` and
`GET /ilp` there locally, whether or not the overlay is on.

**No certificate work happens on this box under the overlay.** `render.sh`
skips DNS_PROVIDER and its credentials entirely and renders neither
`dns-01.env` nor `nginx/conf.d/node.conf` (removing them if a box had them
from before the switch was flipped); `bootstrap.sh` skips
`./init-letsencrypt.sh`; and `init-letsencrypt.sh` itself refuses to spend a
Let's Encrypt call and exits 0 immediately. The wildcard for
`*.gw.devnet.toonprotocol.dev` over DNS-01 via Porkbun is issued by the host's
edge instead (toon-protocol/infra#24).

`docker-compose.yml`'s `gateway` service is still built on the box while its
pin is the `sha-0000000` placeholder (`pull-images.sh`, from `../Dockerfile`,
build context `..`) — the overlay does not touch that; it only adds network
membership and a memory limit to the same service.

The devnet host turned out to be a 1 GB Linode nanode (961 MB total, ~350 MB
used by OS/Docker before any node starts), not the 2 GB host first assumed
when the overlay's `mem_limit`s were provisional. `gateway`'s and
`connector`'s limits are now sized from real `docker stats` measurements
taken 2026-09-25 (toon-protocol/infra#25 step 2): the gateway app idled at
43 MB (limit 192m, ≈4× idle) and the connector idled at 7 MB (limit 64m,
≈4× idle). `nginx` and `certbot` keep their original 32m limits unmeasured —
both stay disabled under this overlay, so nobody has measured them running.

`bootstrap.sh` refuses, before `docker compose up -d`, if `SHARED_EDGE=1` and
the external `edge-gateway` network does not exist yet — it is created by the
host's edge (toon-protocol/infra#24), not by this bundle, so bring that up
first. `auto-apply.sh`'s nginx-reload step is skipped entirely under the
overlay (nginx never runs, so there is nothing to reload).

**The auto-apply units are per node.** `toon-auto-apply-gateway.service` and
`.timer` (lock: `/var/lock/toon-auto-apply-gateway.lock`), not the unqualified
`toon-auto-apply.*` this bundle shipped before — several nodes can end up on
one host (toon-protocol/infra#25), and a shared systemd instance needs names
that do not collide across them. A box already running the old, unqualified
units keeps working unchanged; they point at the same `auto-apply.sh`. At
cutover (toon-protocol/infra#25), migrate it once:

```bash
systemctl disable --now toon-auto-apply.timer
rm /etc/systemd/system/toon-auto-apply.service /etc/systemd/system/toon-auto-apply.timer
./bootstrap.sh   # installs and enables toon-auto-apply-gateway.{service,timer}
```

## Standing one up

**Before you start** you need a host, the three DNS A-records above, API
credentials for the DNS provider that holds your zone (§ "DNS-01"), and 1–2
devnet SOL for the connector's Solana settlement address, which `keys.sh`
prints in step 3.

**1. Clone and configure.** Clone `main` and leave the checkout exactly as it
is: `auto-apply.sh` keeps the box up to date by fast-forwarding it, and stops
on a dirty tree. Everything that is yours goes in `.env`, which is
gitignored.

```bash
git clone https://github.com/toon-protocol/gateway /root/gateway
cd /root/gateway/deploy
cp .env.example .env
$EDITOR .env          # every variable is documented in the file
```

Fill in `ILP_ADDRESS`, `GATEWAY_DOMAIN`, `EDGE_HOST`, `DNS_PROVIDER` and that
provider's lines; `keys.sh` fills in the two operator credentials in step 2.
The relay and settlement block is the **devnet preset**: leave it to front
workloads on the TOON devnet, which settles in mock USDC. See § "Make it
yours" for what each value decides.

**2. Generate the key material.** One command, on the box, before anything
else runs on it. It needs only `python3`, which every Ubuntu release ships:

```bash
./keys.sh init
```

It writes whatever is missing and never replaces what exists, so it is safe to
re-run and safe to run over keys you brought yourself. Put your own in place
first if you have them.

| What | Where | What it is |
|---|---|---|
| `signer.key` | file | **This gateway's identity**: the key a tenant seals its handover to. |
| `settlement.key` | file | The connector's EVM settlement key. |
| `settlement-solana.key` | file | The connector's Solana settlement key. |
| `OPERATOR_BEARER_TOKEN` | `.env` | Gates the connector's `/metrics` and redeem endpoints. |
| `OPERATOR_WRITE_KEY` | `.env` | The **public** half of a fresh ed25519 key for signing operator writes. |

The three files are `0600`, and each is 32 bytes as 64 hex characters, the
only format the connector reads.

`signer.key` is the key a tenant **seals its handover to**. The gateway process
itself holds no key at all — nothing is signed and nothing is published on
either side (spec §12.1, ADR 0016) — so as far as a tenant is concerned this
connector's signing key *is* the gateway. Replacing it makes this a different
gateway, and every grant already handed over stops being addressable.

The operator write key's **private** half is printed once and stored nowhere
on the box. Save it as a file on the machine you administer from: it is what
`connector send --operator-key <file>` signs with. To use a key you already
hold instead, set `OPERATOR_WRITE_KEY` to what `connector send --operator-key
<file> --print-keyid` prints for it before you run `init`.

Back the three key files up somewhere off this box, as `init` reminds you. A
lost `signer.key` is a lost gateway.

**3. Fund what `./keys.sh addresses` prints.**

```bash
./keys.sh addresses
```

It prints the connector's Solana settlement address in base58 with its faucet
command, and its EVM address, which needs nothing to boot (§ "Funding" says
why). Fund the Solana one **before** the first `up -d`: an unfunded Solana key
is a refuse-to-start. `bootstrap.sh` checks its balance with a free
`getBalance` before it touches the host, and stops with the same list if it
is short, rather than letting the connector restart-loop.

**4. Bring it up.**

```bash
./bootstrap.sh
```

That hardens the firewall, installs Docker, writes the internal certificate,
renders the config (refusing, by name, anything in `.env` that is missing or
the wrong shape), pulls and starts the four containers, requests a
certificate, and enables the auto-apply timer. It is idempotent — re-run it to
reconcile a box.

`init-letsencrypt.sh` warns first if `anything.${GATEWAY_DOMAIN}` (the
wildcard) or `${EDGE_HOST}` do not yet resolve to this box — DNS-01 does not
need that to issue, but nothing will reach the gateway through them until they
do. If issuance itself fails, it exits non-zero naming the likely cause (almost
always `DNS_PROVIDER`'s credentials or zone in `.env`), and `bootstrap.sh`
stops there with that message and the command to re-run, rather than reporting
the box up on no valid certificate. A certificate that is still valid and
outside its renewal window — the case on every idempotent re-run — is reused
without going near any of this.

**5. Go to production TLS.** `bootstrap.sh` starts on Let's Encrypt *staging*
so a mistake does not burn the real rate limit for a wildcard. Once step 4
succeeds, set `LETSENCRYPT_STAGING=0` in `.env` and re-run
`./init-letsencrypt.sh`.

## Funding

The handover route is free, so this node never charges anybody. It still needs
two funded settlement identities, for two different reasons.

The chains are whichever the `SETTLEMENT_*` lines of `.env` name. What
follows is written for the devnet preset — Base Sepolia and Solana devnet —
and holds the same way on any other chain, with that chain's own money.

**Solana — required to boot.** `SolanaSettlementBackend::connect` submits and
confirms a real transaction at startup (an idempotent associated-token-account
create), paid by this key. An unfunded key is a refuse-to-start and the
container restart-loops. On the devnet preset **1–2 devnet SOL is plenty**;
get it from <https://faucet.solana.com>.

**EVM — not needed to boot.** Boot on the EVM chain is read-only: chain id, the
token network resolved through the registry, and the token's own `decimals()`.
The key needs ETH only when it transacts — a redeem, say. Nothing on this box
checks a balance, so under-funding surfaces as an ordinary settlement error
later, never at load time.

Neither key needs the settlement token. Money flows *to* a gateway's connector only if someone
prices its route, and nobody does.

`./keys.sh addresses` prints both addresses from the key files, before
anything has booted. Each is derived the way the connector derives it, and
`keys.test.mjs` holds each derivation to the connector's own on fixed keys:

- the Solana address is the ed25519 public key of `settlement-solana.key`, in
  base58: the same bytes `connector send --operator-key settlement-solana.key
  --print-keyid` prints in hex;
- the EVM address comes from `settlement.key`, printed with EIP-55 casing.
  `GET /ilp` prints the same address in lowercase.

Once the node is up, `GET /ilp` serves both as well, after the connector has
proved each of them against a live chain.

## Checking it works

```bash
docker compose ps                              # four services; gateway and connector healthy

# the sealing key a tenant pins — 200 only once the connector is serving AND
# has read its signer key file, which "Up" alone does not prove
curl https://<EDGE_HOST>/ilp/identity

# the self-description: the one route, its price of 0, and the settlement
# addresses a tenant opens a channel against
curl https://<EDGE_HOST>/ilp

# a hostname this gateway holds no grant for. 503 with this header is the
# healthy, empty state — it means the gateway answered and dialled nothing.
curl -i https://anything.<GATEWAY_DOMAIN>/ | grep toon-gateway-reason
# toon-gateway-reason: no_grant
```

To prove the whole path, spawn a workload on a provider and seal a Gateway
Handover to `<ILP_ADDRESS>.handover` at this edge
(`g.toon.workload-gateway.handover` on the devnet box). The tenant tool is
`tools/grant` in the provider repository.

## How updates arrive

The box follows a branch. Every five minutes `toon-auto-apply-gateway.timer`
runs `auto-apply.sh`, which fast-forwards the checkout, re-renders the config, pulls
both images, brings the stack up, and then **verifies** — the gateway and the
connector must both report healthy, and the running connector's `GET /ilp`
must advertise exactly what the rendered config says it should.

It refuses rather than guesses: a dirty working tree stops it loudly, only a
fast-forward is ever applied, a pull that fails fails the whole apply rather
than leaving a stale container running, and a box that comes back unhealthy
exits non-zero so `systemctl status` and the journal show it.

**A render or apply failure is retried, and reported, forever — never
silently sat on (TOON_Network#160).** Once everything above succeeds, this
script records the commit it just applied in `deploy/.applied` (gitignored).
The *next* run compares `HEAD` to `.applied`, not to whatever `git fetch`
just brought back — so if `render.sh`, `pull-images.sh` or anything after it
fails partway through, the box is left on the new commit with the OLD
rendered config and containers, but `.applied` still names the OLD one, and
the very next timer tick treats that as work to do even though the fetch
brings back nothing new. It fails the same way, by the same name, on every
run — `systemctl status` and the journal keep showing it — until whatever
`render.sh` named (most often a newly-required `.env` variable;
`.env.example` lists every one, with the devnet preset for settlement) is
fixed and a run finally succeeds and rewrites `.applied`.

On a box with no `deploy/.applied` yet — an existing box's first run under
this check, or one where the file was lost — that absence is read as
*needing* an apply, not as "must already be applied": the run re-renders,
re-verifies and writes `.applied` once everything reports healthy. That run
is a harmless no-op if the box was already caught up (nothing on disk or in
the running containers has anything to change), which is why treating a
missing file this way, rather than having `bootstrap.sh` write it, is the
safer of the two: the box's first-ever apply IS this script's first run, and
it proves itself exactly like every later one does.

This bundle has **no Watchtower**, same as the store and relay boxes and for
the same reason: `gateway` and `connector` are both published images pinned by
an immutable tag (`.github/workflows/publish-gateway-image.yml`,
TOON_Network#155), and a Watchtower has nothing to follow a pin that only ever
moves by a reviewed commit. See "Bumping the connector pin" below; the gateway
pin is bumped the same way, in `docker-compose.yml`'s `gateway.image` line.

**The placeholder pin.** Before the workflow's first publish the `gateway` pin
read `sha-0000000`, git's all-zero "no commit", which no registry has, and
`pull-images.sh` still honours it: for that one tag, and only for the gateway
image, it builds the image from the checkout's `Dockerfile` and tags it with
the pinned name. That is what a fork that has not published yet can use. Any
other pin that will not pull fails the apply.

```bash
systemctl status toon-auto-apply-gateway.timer
journalctl -u toon-auto-apply-gateway.service -n 50
systemctl start toon-auto-apply-gateway.service   # apply now, rather than waiting
```

`TRACK_BRANCH` in `.env` names the branch, defaulting to `main`. It stays a
variable so a box can be parked on a branch deliberately, and because a box
silently following a branch that does not exist would report success every five
minutes while sitting on whatever it was last deployed with.

## Bumping the connector pin

The `image:` line in `docker-compose.yml` is the pin of record, and
`deploy/bundle.test.mjs` fails the build if a second copy of a connector build
appears anywhere else in the bundle.

Pin an immutable tag — a `rust-sha-<short>` build or a `rust-<handle>` release
alias — never the floating `rust-main`, and never the fleet's old
`rust-release` pointer, which is retired and frozen on a build whose peerings
can accept but never pay.

The config parser is `deny_unknown_fields` and startup is fail-closed, so a
schema drift under you is a refuse-to-start rather than a degraded run. That is
the behaviour you want, but it means the order matters: **land a config change
before the build that requires it.** Here the pin and the config it was
validated against are the same commit and the box takes both with one
fast-forward, so a build can never reach this box ahead of the config it needs.

The current pin is `rust-2026.09.11.1` (= `rust-sha-f278cd6`), the build the
sandbox proves this gateway and its provider against end to end. The rest of
the devnet fleet is a release behind on `rust-2026.08.28.1`; the 09.11 release
is purely additive to the config schema (`[[tokens]]`, `[[rates]]`,
`socks_proxy`, all optional and all absent here), so the two interoperate.

## Privacy and exposure invariants

**The door is not published, and must never be.** `GATEWAY_HANDOVER_PORT`
(8081) appears in no `ports:` row and in no nginx upstream. Reaching it
directly would be a way to tell this gateway what to serve without paying its
connector a packet — which is the one thing the connector exists to prevent.

**The connector's edge is loopback-published.** `127.0.0.1:4000:4000`. nginx is
what faces the internet.

**`ports:` bypasses ufw.** Docker manages its own iptables rules ahead of
ufw's, so a container published with `ports:` is reachable from the internet
*regardless of what `ufw status` shows*. Never drop the `127.0.0.1:` prefix
from the connector's publish, and never convert an `expose:` into a bare
`ports:`.

**`GATEWAY_DIAL_REWRITE` is absent, deliberately.** It is the sandbox's one
setting that would be wrong in a deployment: here a member is dialled where its
own Profile says it is.

## Make it yours

You make this box yours in `.env` and nowhere else. The committed files stay
exactly as they are on `main`, which is what lets `auto-apply.sh` keep
fast-forwarding you onto every reviewed change — it stops on a dirty tree, and
a box on a fork of these files is a box that has stopped getting updates.

What each part of `.env` decides:

* **`ILP_ADDRESS`** — this gateway's own address. The connector's `[node]`
  answers for it and the one route it terminates is `<ILP_ADDRESS>.handover`,
  both rendered from this one value so they cannot disagree. There is no
  default. Pick one of your own, such as `g.<your-name>.workload-gateway`:
  `render.sh` refuses anything under `g.toon.`, which is the TOON fleet's own
  namespace. (The devnet box sets `TOON_DEVNET_BOX=1` to use
  `g.toon.workload-gateway`; nobody else should.)
* **`GATEWAY_DOMAIN` and `EDGE_HOST`** — your two names, § "Two names".
* **`DNS_PROVIDER`** and its lines — how the wildcard is proved, § "DNS-01".
  If your provider is not shipped, it is one new file (§ "Adding a DNS
  provider"); send it upstream and the next operator on that provider gets it
  for free.
* **The devnet preset** — `GATEWAY_RELAYS` and the `SETTLEMENT_*` lines. Keep
  them to front workloads on the TOON devnet. To run on another network,
  replace the block as a whole: the relay, each chain's RPC, its registry or
  program, and its token are facts about that network, and the connector
  checks each against the live chain at boot.
* **Your keys** — `signer.key` and the two settlement keys, § "Standing one
  up". They are files beside `.env`, gitignored the same way.

`connector.toml.template` still reads top to bottom as the whole of the
connector's configuration: its values are `${VARIABLES}` from `.env`, and its
`#:` lines are notes on the template that `render.sh` drops.
