#!/usr/bin/env bash
# Render the files that carry deployment-specific values.
#
#   connector.toml.template   -> connector.toml            (paths, no secrets)
#   .env OPERATOR_BEARER_TOKEN-> operator-bearer.token     (0600 — a secret)
#   .env OPERATOR_WRITE_KEY   -> operator-write.keys       (0600 — public keys)
#   nginx/node.conf.template  -> nginx/conf.d/node.conf
#   .env DNS_PROVIDER + its   -> dns-01.env                (0600 — a secret)
#        <PROVIDER>_* lines
#
# Every output is gitignored, and so is .env, the one input an operator writes.
# Nothing an operator makes theirs is a committed file, so a box runs from an
# unmodified checkout and auto-apply.sh can fast-forward it (it stops on a
# dirty tree). The templates are the fleet's; .env is yours.
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
# Settlement is required, with no default: which chain and token this node is
# paid in is a fact about the network it joins, and a silent default would be
# the devnet's mock USDC. .env.example carries the devnet's as a preset.
: "${ILP_ADDRESS:?set ILP_ADDRESS in .env (the ILP address of this node; the handover route hangs off it)}"
: "${SETTLEMENT_EVM_RPC_URL:?set SETTLEMENT_EVM_RPC_URL in .env (.env.example has the devnet preset)}"
: "${SETTLEMENT_EVM_REGISTRY:?set SETTLEMENT_EVM_REGISTRY in .env (.env.example has the devnet preset)}"
: "${SETTLEMENT_EVM_TOKEN:?set SETTLEMENT_EVM_TOKEN in .env (.env.example has the devnet preset)}"
: "${SETTLEMENT_EVM_DECIMALS:?set SETTLEMENT_EVM_DECIMALS in .env (.env.example has the devnet preset)}"
: "${SETTLEMENT_SOLANA_RPC_URL:?set SETTLEMENT_SOLANA_RPC_URL in .env (.env.example has the devnet preset)}"
: "${SETTLEMENT_SOLANA_PROGRAM_ID:?set SETTLEMENT_SOLANA_PROGRAM_ID in .env (.env.example has the devnet preset)}"
: "${SETTLEMENT_SOLANA_TOKEN:?set SETTLEMENT_SOLANA_TOKEN in .env (.env.example has the devnet preset)}"
: "${SETTLEMENT_SOLANA_DECIMALS:?set SETTLEMENT_SOLANA_DECIMALS in .env (.env.example has the devnet preset)}"
: "${DNS_PROVIDER:?set DNS_PROVIDER in .env (the DNS-01 hook: a file under certbot/, e.g. porkbun or cloudflare)}"
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

# ── Nobody takes the fleet's namespace by accident ───────────────────────────
# `g.toon` and everything under it are the TOON fleet's own addresses. A second
# gateway copying the devnet box's .env would otherwise answer for
# `g.toon.workload-gateway` too, and a tenant's handover would be paid to and
# unsealed by whichever connector the packet happened to reach. The fleet's own
# boxes say so outright.
case "$ILP_ADDRESS" in
  g.toon | g.toon.*)
    if [ "${TOON_DEVNET_BOX:-0}" != 1 ]; then
      echo "ILP_ADDRESS=${ILP_ADDRESS} is under g.toon., the TOON fleet's own namespace." >&2
      echo "Pick an address of your own (e.g. g.<your-name>.workload-gateway). Only the" >&2
      echo "fleet's own boxes set TOON_DEVNET_BOX=1 in .env to use one." >&2
      exit 1
    fi
    ;;
esac

# ── Values that land inside TOML ─────────────────────────────────────────────
# Each of these is written between quotes, or bare as a number, in
# connector.toml. A stray quote, space or newline would render a file the
# connector refuses at boot — or, worse, one that parses as something else —
# so each is checked for its shape here, where the message can name the line
# in .env to fix. The connector still proves the chain values against a live
# chain at boot; this only keeps a typo from reaching it.
refuse_shape() {
  echo "$1=$2 in .env is not $3." >&2
  exit 1
}
# Held in variables, as the bash manual advises for [[ =~ ]]: a regex written
# inline is read through the shell's quoting rules first, and the `"` inside
# RE_URL's bracket expression would not reach the regex intact.
#
# ILP addresses: RFC 0015's allocation schemes, then dot-separated segments.
RE_ILP='^(g|private|example|peer|self|test[1-3]?|local)(\.[A-Za-z0-9_~-]+)+$'
RE_URL='^https?://[^[:space:]"]+$'
RE_EVM='^0x[0-9a-fA-F]{40}$'
RE_B58='^[1-9A-HJ-NP-Za-km-z]{32,44}$'
RE_DEC='^[0-9]{1,2}$'
RE_HOOK='^[a-z0-9][a-z0-9_-]*$'
[[ "$ILP_ADDRESS" =~ $RE_ILP ]] \
  || refuse_shape ILP_ADDRESS "$ILP_ADDRESS" "an ILP address (e.g. g.<your-name>.workload-gateway)"
for name in SETTLEMENT_EVM_RPC_URL SETTLEMENT_SOLANA_RPC_URL; do
  [[ "${!name}" =~ $RE_URL ]] || refuse_shape "$name" "${!name}" "an http(s) URL"
done
for name in SETTLEMENT_EVM_REGISTRY SETTLEMENT_EVM_TOKEN; do
  [[ "${!name}" =~ $RE_EVM ]] || refuse_shape "$name" "${!name}" "a 0x-prefixed 20-byte EVM address"
done
for name in SETTLEMENT_SOLANA_PROGRAM_ID SETTLEMENT_SOLANA_TOKEN; do
  [[ "${!name}" =~ $RE_B58 ]] || refuse_shape "$name" "${!name}" "a base58 Solana address"
done
for name in SETTLEMENT_EVM_DECIMALS SETTLEMENT_SOLANA_DECIMALS; do
  [[ "${!name}" =~ $RE_DEC ]] || refuse_shape "$name" "${!name}" "a whole number of decimals"
done

# `#:` lines are notes on the template itself and are dropped here, before
# envsubst, so a note may mention a ${VARIABLE} without it being substituted.
sed '/^#:/d' connector.toml.template \
  | envsubst '${EDGE_HOST} ${GATEWAY_DOMAIN} ${ILP_ADDRESS} ${SETTLEMENT_EVM_RPC_URL} ${SETTLEMENT_EVM_REGISTRY} ${SETTLEMENT_EVM_TOKEN} ${SETTLEMENT_EVM_DECIMALS} ${SETTLEMENT_SOLANA_RPC_URL} ${SETTLEMENT_SOLANA_PROGRAM_ID} ${SETTLEMENT_SOLANA_TOKEN} ${SETTLEMENT_SOLANA_DECIMALS}' \
  > connector.toml

# ── The DNS-01 hook's environment ────────────────────────────────────────────
# DNS_PROVIDER names a hook, certbot/<DNS_PROVIDER>.py, and the hook reads its
# credentials from variables named <PROVIDER>_* (upper case, `-` as `_`):
# PORKBUN_API_KEY for porkbun, CLOUDFLARE_API_TOKEN for cloudflare. The
# certbot container is given exactly those, plus DNS_PROVIDER, through this
# file and docker-compose.yml's `env_file:` — never the whole of .env, which
# holds the operator bearer token. Because the prefix is a naming rule rather
# than a list, a third provider is one new file under certbot/ and a few lines
# of .env; nothing here, in init-letsencrypt.sh or in docker-compose.yml
# changes. README.md § "DNS-01" is the interface.
[[ "$DNS_PROVIDER" =~ $RE_HOOK ]] \
  || refuse_shape DNS_PROVIDER "$DNS_PROVIDER" "a hook name (lower case, e.g. porkbun or cloudflare)"
[ -f "certbot/${DNS_PROVIDER}.py" ] || {
  echo "DNS_PROVIDER=${DNS_PROVIDER} names no hook: certbot/${DNS_PROVIDER}.py does not exist." >&2
  shipped=(certbot/*.py); shipped=("${shipped[@]#certbot/}")
  echo "Shipped: ${shipped[*]%.py}" >&2
  exit 1
}
DNS_PREFIX="$(printf '%s' "$DNS_PROVIDER" | tr 'a-z-' 'A-Z_')_"
# The names come from the lines of .env itself, not from the environment
# render.sh happens to run in: a PORKBUN_API_KEY exported in somebody's shell
# must not end up in a file on this box because they rendered from it.
dns_vars=()
while IFS= read -r name; do
  [[ "$name" == "$DNS_PREFIX"* && "$name" != DNS_PROVIDER ]] && dns_vars+=("$name")
done < <(sed -nE 's/^(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)=.*/\2/p' .env | sort -u)
[ "${#dns_vars[@]}" -gt 0 ] || {
  echo "DNS_PROVIDER=${DNS_PROVIDER}, but .env sets no ${DNS_PREFIX}* variable for its hook." >&2
  echo "certbot/${DNS_PROVIDER}.py's header lists the ones it reads." >&2
  exit 1
}
{
  echo "# The DNS-01 hook's environment. Rendered from .env by ./render.sh; do not edit."
  printf 'DNS_PROVIDER=%s\n' "$DNS_PROVIDER"
  for name in "${dns_vars[@]}"; do
    # Single-quoted, which compose reads literally. A quote or a newline in a
    # credential cannot be carried that way, and no DNS API issues one.
    case "${!name}" in
      *"'"* | *$'\n'*) echo "${name} in .env contains a quote or a newline, which dns-01.env cannot carry." >&2; exit 1 ;;
    esac
    printf "%s='%s'\n" "$name" "${!name}"
  done
} > dns-01.env

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
chmod 600 connector.toml operator-bearer.token operator-write.keys dns-01.env
if [ "$(id -u)" = 0 ]; then
  chown "${CONNECTOR_UID:-10001}:${CONNECTOR_UID:-10001}" \
    connector.toml operator-bearer.token operator-write.keys
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
echo "  ILP address          : ${ILP_ADDRESS} (handover: ${ILP_ADDRESS}.handover)"
echo "  DNS-01 hook          : certbot/${DNS_PROVIDER}.py"
