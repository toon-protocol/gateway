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
* `gateway` — this repository, built from the checkout the box follows.
* `connector` — the gateway's own payment proxy (ADR 0013). It unseals a
  Gateway Handover and forwards it to the gateway's door.

| File | What it is |
|---|---|
| `docker-compose.yml` | The four services. The connector's pin lives here and nowhere else. |
| `connector.toml.template` | The connector's whole configuration. Rendered; names key paths, holds no secret. |
| `nginx/node.conf.template` | The two server blocks. Rendered. |
| `certbot/porkbun.py` | The DNS-01 auth and cleanup hooks. No plugin, no image of our own. |
| `render.sh` | Renders the above from `.env`. Idempotent. |
| `bootstrap.sh` | Fresh host → running box. Idempotent. |
| `init-letsencrypt.sh` | Issues or reuses the certificate. Idempotent. |
| `auto-apply.sh` + the two units | The box half of GitOps: follow the branch, apply what merged. |
| `.env.example` | Every variable, with what it is and how to generate it. |
| `bundle.test.mjs` | The guard. Reads the real files above; `npm run test:deploy`. |

`.env`, the rendered `connector.toml`, `operator-bearer.token`,
`operator-write.keys`, `nginx/conf.d/`, `tls/` and all key material are
gitignored. **Only templates are committed.**

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

It does that with `certbot/porkbun.py` — two Porkbun API calls in plain
`python3`, which the stock `certbot/certbot` image already has. No plugin is
baked in and no image of our own is published, pinned or rebuilt for two HTTP
requests. certbot records the hook commands in the renewal configuration, so
the unattended `certbot renew` loop renews the wildcard exactly the way it was
issued.

The practical consequences:

* the box needs `PORKBUN_API_KEY`, `PORKBUN_SECRET_KEY` and `PORKBUN_ZONE`;
* `PORKBUN_ZONE` is the **registered** domain — Porkbun's API is addressed by
  zone, and `gw.devnet.toonprotocol.dev` is not one;
* DNS does **not** have to point at the box before the certificate is issued.
  DNS-01 proves control of the zone, not of the host.

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

## Standing one up

**Before you start** you need a host, the three DNS A-records above, Porkbun
API credentials, and three key files.

**1. Clone and configure.**

```bash
git clone https://github.com/toon-protocol/gateway /root/gateway
cd /root/gateway/deploy
git checkout <the branch this box follows>
cp .env.example .env
$EDITOR .env          # every variable is documented in the file
```

**2. Generate the key material.** Three files, all `0600`, none of them ever
committed. Each is 32 bytes as 64 hex characters — the only format the
connector reads.

```bash
openssl rand -hex 32 > signer.key             # THIS GATEWAY'S IDENTITY
openssl rand -hex 32 > settlement.key         # the EVM settlement key
openssl rand -hex 32 > settlement-solana.key  # the Solana settlement key
chmod 600 *.key
```

`signer.key` is the key a tenant **seals its handover to**. The gateway process
itself holds no key at all — nothing is signed and nothing is published on
either side (spec §12.1, ADR 0016) — so as far as a tenant is concerned this
connector's signing key *is* the gateway. Replacing it makes this a different
gateway, and every grant already handed over stops being addressable.

Record how each key was derived, somewhere off this box. A lost `signer.key`
is a lost gateway.

**3. Fund the two settlement identities.** See § "Funding", below. Do this
**before** the first `up -d`: an unfunded Solana key is a refuse-to-start.

**4. Bring it up.**

```bash
./bootstrap.sh
```

That hardens the firewall, installs Docker, writes the internal certificate,
renders the config, builds and starts the four containers, requests a
certificate, and enables the auto-apply timer. It is idempotent — re-run it to
reconcile a box.

**5. Go to production TLS.** `bootstrap.sh` starts on Let's Encrypt *staging*
so a mistake does not burn the real rate limit for a wildcard. Once a staging
certificate has issued cleanly, set `LETSENCRYPT_STAGING=0` in `.env` and
re-run `./init-letsencrypt.sh`.

## Funding

The handover route is free, so this node never charges anybody. It still needs
two funded settlement identities, for two different reasons.

**Solana — required to boot.** `SolanaSettlementBackend::connect` submits and
confirms a real transaction at startup (an idempotent associated-token-account
create), paid by this key. An unfunded key is a refuse-to-start and the
container restart-loops. **1–2 devnet SOL is plenty**; get it from
<https://faucet.solana.com>.

**EVM — not needed to boot.** Base Sepolia boot is read-only: chain id, the
token network resolved through the registry, and the token's own `decimals()`.
The key needs ETH only when it transacts — a redeem, say. Nothing on this box
checks a balance, so under-funding surfaces as an ordinary settlement error
later, never at load time.

Neither key needs USDC. Money flows *to* a gateway's connector only if someone
prices its route, and nobody does.

Print the two addresses from the key files:

```bash
# EVM
cast wallet address --private-key "0x$(cat settlement.key)"

# Solana: --print-keyid gives the raw ed25519 public key in hex; Solana spells
# the same bytes in base58.
docker run --rm -v "$PWD:/d:ro" ghcr.io/toon-protocol/connector:rust-2026.09.11.1 \
  send --operator-key /d/settlement-solana.key --print-keyid
```

Both are also served, already derived, by `GET /ilp` once the node is up —
which is the copy to trust, because the connector proved each of them against a
live chain when it booted.

## Checking it works

```bash
docker compose ps                              # four services; gateway and connector healthy

# the sealing key a tenant pins — 200 only once the connector is serving AND
# has read its signer key file, which "Up" alone does not prove
curl https://proxy.gateway.<domain>/ilp/identity

# the self-description: the one route, its price of 0, and the settlement
# addresses a tenant opens a channel against
curl https://proxy.gateway.<domain>/ilp

# a hostname this gateway holds no grant for. 503 with this header is the
# healthy, empty state — it means the gateway answered and dialled nothing.
curl -i https://anything.<gateway domain>/ | grep toon-gateway-reason
# toon-gateway-reason: no_grant
```

To prove the whole path, spawn a workload on a provider and seal a Gateway
Handover to `g.toon.workload-gateway.handover` at this edge. The tenant tool is
`tools/grant` in the provider repository.

## How updates arrive

The box follows a branch. Every five minutes `toon-auto-apply.timer` runs
`auto-apply.sh`, which fast-forwards the checkout, re-renders the config,
rebuilds the gateway image, brings the stack up, and then **verifies** — the
gateway and the connector must both report healthy, and the running connector's
`GET /ilp` must advertise exactly what the rendered config says it should.

It refuses rather than guesses: a dirty working tree stops it loudly, only a
fast-forward is ever applied, and a box that comes back unhealthy exits
non-zero so `systemctl status` and the journal show it.

This bundle has **no Watchtower**, unlike the store and relay boxes. Those run
a published image on a moving `:release` tag; this repository publishes no
image yet, so the gateway is built from the checkout and the update path is the
git one — app and config together, in one reviewed commit. Adding a
`publish-gateway-image.yml` and switching to a pinned image is a clean
follow-up; nothing else here would change.

```bash
systemctl status toon-auto-apply.timer
journalctl -u toon-auto-apply.service -n 50
systemctl start toon-auto-apply.service   # apply now, rather than waiting
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

Most of `connector.toml.template` describes any Workload Gateway behind any
connector. The part specific to the TOON devnet is fenced under **"THIS
DEPLOYMENT"** at the bottom — the `[node]` addresses and public URLs.

Point the settlement sections at whatever chain and token you settle in,
generate your own `signer.key`, put your own names in `.env`, and the rest of
this directory works unchanged. If your DNS is not Porkbun, `certbot/porkbun.py`
is the one file to replace: it is two API calls behind a fixed hook interface.
