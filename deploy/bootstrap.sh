#!/usr/bin/env bash
# Bring the Workload Gateway box up from a fresh Ubuntu host. Idempotent —
# re-running it reconciles the box rather than rebuilding it.
#
#   ./bootstrap.sh
#
# Expects .env and the three key files to already be in this directory; see
# README.md § "Standing one up". Everything it installs is listed here, and it
# makes no changes outside this directory, ufw, docker, journald and the two
# systemd units it owns.
set -euo pipefail
cd "$(dirname "$0")"

[ -f .env ] || { echo "Missing .env — copy .env.example and fill it in." >&2; exit 1; }
for f in signer.key settlement.key settlement-solana.key; do
  [ -f "$f" ] || { echo "Missing $f — see README.md § Standing one up." >&2; exit 1; }
done

set -a; . ./.env; set +a
: "${GATEWAY_DOMAIN:?set GATEWAY_DOMAIN in .env}"
: "${EDGE_HOST:?set EDGE_HOST in .env}"

echo "==> [1/8] Firewall"
# Only SSH, HTTP (redirect, and an ACME fallback) and HTTPS. This box publishes
# no other port: workloads run on the PROVIDER's host, not here, and the
# connector's edge and the gateway's door are both behind nginx or behind
# nothing at all. Note that docker publishes ports by writing iptables rules
# that BYPASS ufw, so this protects the host but not a container published on
# 0.0.0.0 — which is why docker-compose.yml binds the connector to 127.0.0.1.
apt-get update -y
apt-get install -y ufw curl gettext-base openssl
ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp  comment 'SSH'
ufw allow 80/tcp  comment 'HTTP (redirect)'
ufw allow 443/tcp comment 'HTTPS'
ufw --force enable

echo "==> [2/8] Docker"
command -v docker >/dev/null 2>&1 || curl -fsSL https://get.docker.com | sh

echo "==> [3/8] Cap the journal"
mkdir -p /etc/systemd/journald.conf.d
printf '[Journal]\nSystemMaxUse=100M\n' > /etc/systemd/journald.conf.d/00-cap.conf
systemctl restart systemd-journald || true

echo "==> [4/8] The internal TLS certificate"
# The hop from nginx to the gateway is TLS so that the gateway reports
# `X-Forwarded-Proto: https` to the workload — it reads that from its own
# listener, not from a header (docker-compose.yml says more). This certificate
# is presented only on the compose network, to nginx, which does not verify it.
# It is therefore long-lived on purpose: expiring it would be a scheduled
# outage bought for nothing.
mkdir -p tls
if [ ! -s tls/internal.crt ] || ! openssl x509 -checkend 2592000 -noout -in tls/internal.crt >/dev/null 2>&1; then
  openssl req -x509 -nodes -newkey rsa:2048 -days 7300 \
    -keyout tls/internal.key -out tls/internal.crt \
    -subj "/CN=*.${GATEWAY_DOMAIN}" \
    -addext "subjectAltName=DNS:*.${GATEWAY_DOMAIN},DNS:${GATEWAY_DOMAIN},DNS:gateway"
  echo "    wrote tls/internal.crt (self-signed, 20 years, compose-network only)"
else
  echo "    tls/internal.crt is present and not near expiry — kept"
fi
# The gateway container runs as root (node:22-slim's default), so a 0600 file
# owned by root here is readable. Keep the key un-world-readable anyway.
chmod 600 tls/internal.key
chmod 644 tls/internal.crt

echo "==> [5/8] Render config"
./render.sh

echo "==> [6/8] Build and start"
docker compose pull --ignore-buildable --ignore-pull-failures
docker compose build
docker compose up -d

echo "==> [7/8] TLS"
./init-letsencrypt.sh

echo "==> [8/8] The auto-apply timer"
# The box follows the tracked branch from here on: every five minutes it
# fast-forwards, re-renders and applies. ExecStart is absolute, so the unit
# only works from the checkout path it names — README § "Standing one up"
# clones to /root/gateway for exactly that reason.
install -m 644 toon-auto-apply.service /etc/systemd/system/toon-auto-apply.service
install -m 644 toon-auto-apply.timer   /etc/systemd/system/toon-auto-apply.timer
systemctl daemon-reload
systemctl enable --now toon-auto-apply.timer

echo
echo "Workload Gateway box up."
echo "  workloads      : https://<label>.${GATEWAY_DOMAIN}/"
echo "  ILP edge       : https://${EDGE_HOST}/ilp"
echo "  sealing key    : https://${EDGE_HOST}/ilp/identity   (what a tenant seals a handover to)"
echo
echo "A hostname this gateway holds no grant for answers 503 with"
echo "  toon-gateway-reason: no_grant — that is the healthy, empty state."
