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
# does need PORKBUN_API_KEY, PORKBUN_SECRET_KEY and PORKBUN_ZONE in .env, and
# it does need nginx able to start (the dummy certificate below is what lets it
# start before there is a real one).
set -euo pipefail
cd "$(dirname "$0")"

set -a; . ./.env; set +a
: "${GATEWAY_DOMAIN:?set GATEWAY_DOMAIN in .env}"
: "${EDGE_HOST:?set EDGE_HOST in .env}"
: "${LETSENCRYPT_EMAIL:?set LETSENCRYPT_EMAIL in .env}"
: "${PORKBUN_ZONE:?set PORKBUN_ZONE in .env}"

DC=(docker compose)
DOMAINS=("${GATEWAY_DOMAIN}" "*.${GATEWAY_DOMAIN}" "${EDGE_HOST}")
CERT_NAME="${CERT_NAME:-${GATEWAY_DOMAIN}}"
CERT_PATH="/etc/letsencrypt/live/${CERT_NAME}"
RENEW_WINDOW_DAYS="${RENEW_WINDOW_DAYS:-30}"

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

d_args=()
for d in "${DOMAINS[@]}"; do d_args+=(-d "$d"); done
staging_arg=""
[ "${LETSENCRYPT_STAGING:-1}" = "1" ] && staging_arg="--staging"

# `--manual` with hooks, not a DNS plugin: see certbot/porkbun.py for why.
# `--manual-public-ip-logging-ok` is not passed and is not needed — no IP is
# logged by a DNS challenge. certbot stores both hook commands in the renewal
# configuration, so the unattended `certbot renew` loop in docker-compose.yml
# renews this the same way it was issued.
echo "==> Requesting a certificate over DNS-01 (${staging_arg:-production})"
echo "    ${DOMAINS[*]}"
if "${DC[@]}" run --rm --entrypoint certbot certbot \
  certonly --manual --preferred-challenges dns \
  --manual-auth-hook    'python3 /opt/hooks/porkbun.py auth' \
  --manual-cleanup-hook 'python3 /opt/hooks/porkbun.py cleanup' \
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
  echo "::warning:: Certificate issuance failed."
  echo "  A DNS-01 failure is almost always the Porkbun credentials or PORKBUN_ZONE:"
  echo "  the zone must be the REGISTERED domain (${PORKBUN_ZONE}), not a subdomain."
  echo "  The certbot log above names the call that failed."
  seed_dummy
  "${DC[@]}" exec nginx nginx -s reload 2>/dev/null || true
fi
