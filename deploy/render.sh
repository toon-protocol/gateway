#!/usr/bin/env bash
# Render the files that carry deployment-specific values.
#
#   connector.toml.template   -> connector.toml            (paths, no secrets)
#   .env OPERATOR_BEARER_TOKEN-> operator-bearer.token     (0600 — a secret)
#   .env OPERATOR_WRITE_KEY   -> operator-write.keys       (0600 — public keys)
#   nginx/node.conf.template  -> nginx/conf.d/node.conf
#
# Every output is gitignored. Edit the templates.
#
# envsubst is given an EXPLICIT variable list. Without one it would substitute
# every $NAME it sees, and the nginx template contains nginx variables ($host,
# $upstream, $binary_remote_addr) that must survive to the rendered file.
set -euo pipefail
cd "$(dirname "$0")"

[ -f .env ] || { echo "Missing .env — copy .env.example and fill it in." >&2; exit 1; }
set -a; . ./.env; set +a

: "${GATEWAY_DOMAIN:?set GATEWAY_DOMAIN in .env}"
: "${EDGE_HOST:?set EDGE_HOST in .env (the hostname of the ILP edge this gateway is paid at)}"
: "${OPERATOR_BEARER_TOKEN:?set OPERATOR_BEARER_TOKEN in .env (openssl rand -hex 32)}"
: "${OPERATOR_WRITE_KEY:?set OPERATOR_WRITE_KEY in .env (the key allowed to sign operator writes)}"
# One certificate lineage covers all three names. It is filed under the
# gateway's domain rather than under the edge host, because the domain is what
# this box is for.
: "${CERT_NAME:=${GATEWAY_DOMAIN}}"
export CERT_NAME

# ── A name that would cost a tenant a hostname ───────────────────────────────
# The gateway serves EVERY single label under GATEWAY_DOMAIN. An edge host
# inside that domain would be a label no tenant could ever be handed, silently,
# and nginx would answer it from the wrong server block. Refuse it here rather
# than discover it the first time a handover asks for that name.
case "${EDGE_HOST}" in
  *".${GATEWAY_DOMAIN}"|"${GATEWAY_DOMAIN}")
    echo "EDGE_HOST (${EDGE_HOST}) must not be under GATEWAY_DOMAIN (${GATEWAY_DOMAIN})." >&2
    echo "Every label under the gateway's domain belongs to a workload; give the" >&2
    echo "ILP edge a name of its own beside it." >&2
    exit 1
    ;;
esac

envsubst '${EDGE_HOST} ${GATEWAY_DOMAIN}' \
  < connector.toml.template > connector.toml

# ── The operator surface's two credentials ───────────────────────────────────
# The connector reads them from files, so connector.toml names paths and holds
# no credential of its own.
#
#   operator-bearer.token   the shared secret that gates operator READS
#   operator-write.keys     the PUBLIC halves allowed to sign operator WRITES,
#                           one per line; `#` starts a comment
printf '%s\n' "${OPERATOR_BEARER_TOKEN}" > operator-bearer.token
{
  echo "# Public keys allowed to sign operator writes, one per line."
  echo "# Rendered from OPERATOR_WRITE_KEY in .env by ./render.sh."
  printf '%s\n' "${OPERATOR_WRITE_KEY}"
} > operator-write.keys

# None of these may be world-readable — but the connector container runs as uid
# 10001, and a root-owned 0600 file is unreadable to it ("failed to read config
# file: Permission denied", then a restart loop). Hand them to that uid rather
# than widening the mode. connector.toml is only paths, so 0600 on it is
# belt-and-braces; the other two really are secrets.
#
# THE HAND-PLACED KEY FILES NEED THE SAME TREATMENT, and the fleet's runbooks
# have always said so as a manual step (connector#492's restart loop:
# "failed to read signer key_file at /app/data/signer.key: Permission denied").
# A step a human has to remember is a step a human forgets, and the failure is
# a container that restarts forever while everything else looks fine. They are
# `chmod 600` here too, so `openssl rand -hex 32 > signer.key` with a default
# umask is corrected rather than merely tolerated.
chmod 600 connector.toml operator-bearer.token operator-write.keys
for key in signer.key settlement.key settlement-solana.key; do
  [ -f "$key" ] && chmod 600 "$key"
done
if [ "$(id -u)" = 0 ]; then
  chown "${CONNECTOR_UID:-10001}:${CONNECTOR_UID:-10001}" \
    connector.toml operator-bearer.token operator-write.keys
  for key in signer.key settlement.key settlement-solana.key; do
    [ -f "$key" ] && chown "${CONNECTOR_UID:-10001}:${CONNECTOR_UID:-10001}" "$key"
  done
else
  echo "note: not running as root, so the rendered files stay owned by $(id -un)." >&2
  echo "      The connector container runs as uid 10001 and will not be able to" >&2
  echo "      read them. Fine for a local render; re-run as root on the box." >&2
fi

mkdir -p nginx/conf.d
envsubst '${EDGE_HOST} ${GATEWAY_DOMAIN} ${CERT_NAME}' \
  < nginx/node.conf.template > nginx/conf.d/node.conf

echo "rendered connector.toml, the operator credential files (0600) and"
echo "  nginx/conf.d/node.conf"
echo "  workloads            : *.${GATEWAY_DOMAIN}"
echo "  ILP edge             : ${EDGE_HOST}"
echo "  certificate lineage  : ${CERT_NAME}"
