#!/usr/bin/env bash
# Issue or reuse this box's ONE certificate, then reload nginx.
#
# Three names on one lineage:
#   ${GATEWAY_DOMAIN}     the bare domain
#   *.${GATEWAY_DOMAIN}   every workload — this is why the challenge is DNS-01
#   ${EDGE_HOST}          the sealed ILP edge, beside the domain
#
# Idempotent and safe to re-run: a valid, non-self-signed certificate that
# already covers all three names and is outside the renewal window is reused
# rather than spending a Let's Encrypt rate-limit slot.
#
# Unlike every other bundle in this fleet, this one does NOT need DNS to point
# at the box first — DNS-01 proves control of the zone, not of the host. It
# does need DNS_PROVIDER and that provider's credentials in .env (rendered into
# dns-01.env by ./render.sh, which must have run), and it does need nginx able
# to start (the dummy certificate below is what lets it start before there is a
# real one).
set -euo pipefail
cd "$(dirname "$0")"

set -a; . ./.env; set +a

# SHARED_EDGE=1 (toon-protocol/gateway#18, infra#24): nginx and certbot are
# disabled by docker-compose.shared-edge.yml and the devnet host's own Caddy
# terminates TLS instead, so this box issues no certificate of its own — there
# is no nginx to seed a dummy into, no dns-01.env (render.sh does not render
# it under the overlay) and no rate-limit slot worth spending.
if [ "${SHARED_EDGE:-0}" = 1 ]; then
  echo "SHARED_EDGE=1 — the devnet host's shared edge terminates TLS (toon-protocol/infra#24);" \
       "this box issues no certificate of its own."
  exit 0
fi

: "${GATEWAY_DOMAIN:?set GATEWAY_DOMAIN in .env}"
: "${EDGE_HOST:?set EDGE_HOST in .env}"
: "${LETSENCRYPT_EMAIL:?set LETSENCRYPT_EMAIL in .env}"
: "${DNS_PROVIDER:?set DNS_PROVIDER in .env}"
[ -f "certbot/${DNS_PROVIDER}.py" ] || { echo "DNS_PROVIDER=${DNS_PROVIDER}: no certbot/${DNS_PROVIDER}.py" >&2; exit 1; }
[ -f dns-01.env ] || { echo "Missing dns-01.env — run ./render.sh first." >&2; exit 1; }

DC=(docker compose)
DOMAINS=("${GATEWAY_DOMAIN}" "*.${GATEWAY_DOMAIN}" "${EDGE_HOST}")
CERT_NAME="${CERT_NAME:-${GATEWAY_DOMAIN}}"
CERT_PATH="/etc/letsencrypt/live/${CERT_NAME}"
RENEW_WINDOW_DAYS="${RENEW_WINDOW_DAYS:-30}"

# The hook interface (README.md § "DNS-01"): `python3 <hook> auth|cleanup`,
# with certbot's CERTBOT_DOMAIN and CERTBOT_VALIDATION and the hook's own
# <PROVIDER>_* credentials in the environment. These two strings are exactly
# what certbot stores in the lineage's renewal configuration — with
# DNS_PROVIDER=porkbun they are byte-for-byte the commands the devnet box's
# existing lineage was issued with, so its renewals carry on untouched.
AUTH_HOOK="python3 /opt/hooks/${DNS_PROVIDER}.py auth"
CLEANUP_HOOK="python3 /opt/hooks/${DNS_PROVIDER}.py cleanup"

seed_dummy() {
  "${DC[@]}" run --rm --entrypoint sh certbot -c "
    mkdir -p '${CERT_PATH}' &&
    openssl req -x509 -nodes -newkey rsa:2048 -days 1 \
      -keyout '${CERT_PATH}/privkey.pem' \
      -out    '${CERT_PATH}/fullchain.pem' \
      -subj '/CN=${GATEWAY_DOMAIN}'"
}

existing_cert_ok() {
  local want_staging="0"
  [ "${LETSENCRYPT_STAGING:-1}" = "1" ] && want_staging="1"
  local sans
  sans="$(printf '%s\n' "${DOMAINS[@]}")"
  "${DC[@]}" run --rm --entrypoint sh certbot -c '
    set -e
    CERT="'"${CERT_PATH}"'/fullchain.pem"
    [ -s "$CERT" ] || exit 0
    openssl x509 -checkend "$(( '"${RENEW_WINDOW_DAYS}"' * 86400 ))" -noout -in "$CERT" >/dev/null 2>&1 || exit 0
    issuer="$(openssl x509 -issuer -noout -in "$CERT")"
    subj="$(openssl x509 -subject -noout -in "$CERT")"
    [ "$issuer" = "$(printf "%s" "$subj" | sed "s/^subject/issuer/")" ] && exit 0
    printf "%s" "$issuer" | grep -qi "Let'"'"'s Encrypt\|(STAGING)\|ACME\|R[0-9]\|E[0-9]" || exit 0
    is_staging=0
    printf "%s" "$issuer" | grep -qi "STAGING\|Fake LE" && is_staging=1
    [ "$is_staging" = "'"${want_staging}"'" ] || exit 0
    # A lineage renews with the hook it was ISSUED with, which certbot wrote
    # into its renewal configuration. After DNS_PROVIDER changes, a lineage
    # still naming the old hook would fail its next unattended renewal — the
    # old provider'"'"'s credentials are gone from the container — so it is
    # re-issued now, with the new hook, while somebody is watching.
    grep -qxF "manual_auth_hook = '"${AUTH_HOOK}"'" "/etc/letsencrypt/renewal/'"${CERT_NAME}"'.conf" 2>/dev/null || exit 0
    san="$(openssl x509 -ext subjectAltName -noout -in "$CERT" 2>/dev/null || openssl x509 -text -noout -in "$CERT")"
    san="$(printf "%s" "$san" | tr "," "\n" | tr -d " " | sed "s/\$/,/")"
    while IFS= read -r d; do
      [ -n "$d" ] || continue
      printf "%s\n" "$san" | grep -qF "DNS:$d," || exit 0
    done <<SANS
'"${sans}"'
SANS
    echo ok
  ' 2>/dev/null | tr -d '[:space:]'
}

# A warning, not a gate: DNS-01 proves control of the ZONE, not of the host,
# so this cannot stop issuance the way it does on an HTTP-01 bundle — but a
# wildcard or edge host that does not resolve here yet means nothing will ever
# reach this box once the certificate exists, and that is worth saying before
# spending a rate-limit slot on it, not after.
warn_if_dns_wrong() {
  local mine d ip
  mine="$(hostname -I 2>/dev/null || true)"
  for d in "anything.${GATEWAY_DOMAIN}" "${EDGE_HOST}"; do
    ip="$(getent ahostsv4 "$d" 2>/dev/null | awk '{print $1; exit}' || true)"
    if [ -z "$ip" ]; then
      echo "::warning:: ${d} does not resolve yet. The certificate will still be requested" \
           "over DNS-01, which does not need this, but nothing will reach this gateway" \
           "through it until the A-record (or, for the wildcard, *.${GATEWAY_DOMAIN}) points here."
    elif [ -n "$mine" ] && ! printf '%s\n' "$mine" | tr ' ' '\n' | grep -qxF "$ip"; then
      echo "::warning:: ${d} resolves to ${ip}, which is not one of this box's own addresses" \
           "(${mine}). Check the A-record — DNS-01 will still issue, but the record may be wrong."
    fi
  done
}

echo "==> Checking for an existing valid certificate (${CERT_NAME})"
if [ "$(existing_cert_ok)" = "ok" ]; then
  echo "==> Valid certificate found — reusing it, not re-issuing."
  "${DC[@]}" up -d nginx
  "${DC[@]}" exec nginx nginx -s reload 2>/dev/null || true
  exit 0
fi

echo "==> Seeding a self-signed certificate so nginx can start"
seed_dummy
"${DC[@]}" up -d nginx
"${DC[@]}" run --rm --entrypoint sh certbot -c \
  "rm -rf /etc/letsencrypt/live/${CERT_NAME} /etc/letsencrypt/archive/${CERT_NAME} /etc/letsencrypt/renewal/${CERT_NAME}.conf"

warn_if_dns_wrong

d_args=()
for d in "${DOMAINS[@]}"; do d_args+=(-d "$d"); done
staging_arg=""
[ "${LETSENCRYPT_STAGING:-1}" = "1" ] && staging_arg="--staging"

# `--manual` with hooks, not a DNS plugin: see certbot/porkbun.py for why.
# Which hook is DNS_PROVIDER's choice, and nothing here names a provider.
# `--manual-public-ip-logging-ok` is not passed and is not needed — no IP is
# logged by a DNS challenge. certbot stores both hook commands in the renewal
# configuration, so the unattended `certbot renew` loop in docker-compose.yml
# renews this the same way it was issued.
echo "==> Requesting a certificate over DNS-01 via ${DNS_PROVIDER} (${staging_arg:-production})"
echo "    ${DOMAINS[*]}"
if "${DC[@]}" run --rm --entrypoint certbot certbot \
  certonly --manual --preferred-challenges dns \
  --manual-auth-hook    "${AUTH_HOOK}" \
  --manual-cleanup-hook "${CLEANUP_HOOK}" \
  $staging_arg \
  --cert-name "${CERT_NAME}" \
  "${d_args[@]}" \
  --email "${LETSENCRYPT_EMAIL}" \
  --rsa-key-size 2048 --agree-tos --no-eff-email --non-interactive \
  --keep-until-expiring; then
  # Tolerant, like the other two reloads in this file, and for a reason worth
  # stating: under `set -e` in bootstrap.sh a failed reload aborted the WHOLE
  # bring-up at the TLS step — which silently skipped installing the
  # auto-apply timer, leaving a box that looked deployed and would never
  # update itself again. nginx is a container that can be mid-restart at this
  # moment; the certificate is on disk either way, and the reload loop in
  # docker-compose.yml picks it up within six hours regardless.
  "${DC[@]}" exec nginx nginx -s reload 2>/dev/null \
    || echo "::warning:: nginx would not reload; it will pick the new certificate up on its own within 6h."
  echo "Done.${staging_arg:+ STAGING certificate — re-run with LETSENCRYPT_STAGING=0 once you are happy.}"
else
  # A dummy is reseeded so nginx still answers something, but this script
  # itself must fail: a gateway serving no valid certificate is the
  # half-configured state worse than one that refused to come up at all
  # (TOON_Network#163), so it is not this script's place to call that "done".
  seed_dummy
  "${DC[@]}" exec nginx nginx -s reload 2>/dev/null || true
  echo "::error:: Certificate issuance failed." >&2
  echo "  A DNS-01 failure is almost always the ${DNS_PROVIDER} credentials or zone in .env" >&2
  echo "  (the zone is the REGISTERED domain, not a subdomain). The certbot log above names" >&2
  echo "  the API call that failed. After fixing .env, re-run ./render.sh, then" >&2
  echo "  \`docker compose up -d certbot\` so renewals see it too, then ./init-letsencrypt.sh." >&2
  exit 1
fi
