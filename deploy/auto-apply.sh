#!/usr/bin/env bash
#
# Apply what was merged. Run by systemd on a timer; see deploy/README.md.
#
# This is the box half of GitOps (connector ADR 0068): the repository is the
# deploy surface, and this script's whole job is to notice that the tracked
# branch moved and apply it.
#
# It is PULL-based on purpose. The alternative -- a CI job holding an SSH key
# into this box -- is the write path ADR 0068 deliberately removed, and putting
# it back is a wider blast radius than the tedium it saves. Nothing outside
# this box can make this box deploy.
#
# It refuses rather than guesses:
#   * a dirty working tree means a human is mid-operation here -- stop, loudly;
#   * only a fast-forward is applied, never a merge or a reset, so a box can
#     never end up on a tree nobody reviewed;
#   * after `up -d` the gateway and the connector must both reach `healthy`, or
#     this exits non-zero so `systemctl status` and the journal show it;
#   * a render or apply failure is retried, and reported, on every run until
#     it is fixed -- never silently sat on with the box left on the new
#     commit and the old config (TOON_Network#160; see `deploy/.applied`,
#     below the fetch, for how).
#
# ── One deliberate difference from the store and relay copies ────────────────
# IT TRACKS A NAMED BRANCH. `TRACK_BRANCH` in .env, defaulting to `main`.
# Named rather than assumed, so a box can be parked on a branch on purpose,
# and because a box that silently followed a branch that does not exist would
# sit on whatever it was last deployed with while reporting success every five
# minutes.
#
# Both `gateway` and `connector` are published images now (TOON_Network#155),
# pulled by the immutable pin `docker-compose.yml` names -- neither is built
# from this checkout once the gateway pin names a published build (until then
# pull-images.sh builds it here, below). What this script fast-forwards is
# still the whole repository, because the RENDERED CONFIG (connector.toml and
# friends) still lives here and still needs render.sh and a restart to take
# effect.
set -euo pipefail

REPO_DIR=$(cd "$(dirname "$0")/.." && pwd)
DEPLOY_DIR="$REPO_DIR/deploy"
cd "$REPO_DIR"

TRACK_BRANCH=main
if [ -f "$DEPLOY_DIR/.env" ]; then
  # Only this one variable, and only from a well-formed line: sourcing .env
  # here would pull the Porkbun credentials and the operator token into this
  # script's environment for no reason.
  value=$(sed -n 's/^[[:space:]]*TRACK_BRANCH[[:space:]]*=[[:space:]]*//p' "$DEPLOY_DIR/.env" | tail -n 1 | tr -d '"'"'"' \t\r')
  [ -n "$value" ] && TRACK_BRANCH=$value
fi

# The [node] addresses a connector.toml advertises, one per line, sorted.
# Scoped to the [node] table (the sed range runs from `[node]` to the next
# table header), so an `addresses = [...]` under any other table can never leak
# into the comparison. KNOWN LIMIT: the sed matches a single-line
# `addresses = [...]` only; a reformatted template parses EMPTY, which the
# caller below refuses loudly instead of letting the verification pass
# vacuously.
advertised_addresses() {
  sed -n '/^\[node\]/,/^[[:space:]]*\[/s/^[[:space:]]*addresses[[:space:]]*=[[:space:]]*\[\(.*\)\].*/\1/p' "$1" \
    | grep -o '"[^"]*"' | tr -d '"' | sort -u || true
}

# Every file render.sh writes that docker-compose.yml bind-mounts into the
# connector, plus the hand-placed key files: a change to ANY of them needs a
# connector restart to become live, not just connector.toml -- a rotated
# OPERATOR_WRITE_KEY re-renders only operator-write.keys, and a revoked key
# that stays authorised is a security bug. Missing files are tolerated (first
# render) and count as a change once they appear.
fingerprint_connector_inputs() {
  { sha256sum \
      connector.toml \
      operator-bearer.token \
      operator-write.keys \
      signer.key \
      settlement.key \
      settlement-solana.key \
      2>/dev/null || true; } | sha256sum | awk '{print $1}'
}

# One apply at a time, and never one racing a human. The path is overridable
# only for tests (TOON_AUTOAPPLY_LOCK) -- a box always takes the real one.
LOCK_FILE=${TOON_AUTOAPPLY_LOCK:-/var/lock/toon-auto-apply.lock}
exec 9>"$LOCK_FILE"
flock -n 9 || { echo "another apply is already running; leaving it alone"; exit 0; }

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "REFUSING: the working tree at $REPO_DIR is dirty."
  echo "Someone is editing on the box. Commit, stash or discard it, then this resumes on its own."
  exit 1
fi

if ! git fetch -q origin "$TRACK_BRANCH"; then
  echo "FAILED: origin has no branch '$TRACK_BRANCH'. Set TRACK_BRANCH in deploy/.env."
  exit 1
fi
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse FETCH_HEAD)

# The commit the LAST run applied AND VERIFIED, held separately from HEAD
# (TOON_Network#160). Without it, "LOCAL = REMOTE" alone reads as "nothing to
# do" even when the PREVIOUS run fast-forwarded here and then failed partway
# through -- render.sh, pull-images.sh, `up -d`, or a health or activation
# check below -- which leaves the box sitting on the new commit with the OLD
# rendered config and the OLD containers, reporting success on every run
# after. Comparing HEAD to `.applied` instead of to what was just fetched
# means a fetch that brings back nothing new is still retried as work when
# the two disagree.
#
# Missing entirely -- an existing box's first run under this check, or one
# whose `deploy/.applied` was lost -- is read the SAFER of the two ways: as
# needing an apply, not as "must already be applied". Re-running the full
# apply against a box already on the right commit with healthy containers is
# a harmless no-op (the fingerprint and the `GET /ilp` comparison below find
# nothing to change), where guessing the other way would paper over a first
# apply that had in fact failed before this file ever existed. bootstrap.sh
# deliberately does not write it either: the box's first-ever apply IS this
# script's first run, and it should prove itself exactly like every later
# one does.
APPLIED_FILE="$DEPLOY_DIR/.applied"
APPLIED=$(cat "$APPLIED_FILE" 2>/dev/null || true)

if [ "$LOCAL" = "$REMOTE" ] && [ "$LOCAL" = "$APPLIED" ]; then
  exit 0   # nothing merged since last time, and it is already applied
fi

if [ "$LOCAL" != "$REMOTE" ]; then
  echo "applying ${LOCAL:0:7} -> ${REMOTE:0:7} (origin/$TRACK_BRANCH)"
  git merge --ff-only FETCH_HEAD
else
  echo "retrying ${LOCAL:0:7}: the last apply did not finish (deploy/.applied is '${APPLIED:-<none>}')"
fi

cd "$DEPLOY_DIR"
# This bundle's connector.toml is RENDERED from connector.toml.template and
# .env, so a pulled template change is not live until render.sh has run.
# render.sh is also what chowns the rendered files to uid 10001 -- it must run
# as root, and systemd runs this as root.
#
# The rendered files are BIND-MOUNTED, and `up -d` recreates a container on a
# changed image or definition, never on changed bytes behind a bind mount -- so
# a rendered change is on disk but not live until the connector rereads it.
# Fingerprint the connector's whole input set around render.sh; a missing
# pre-render file counts as changed, and WHY it changed does not matter.
#
# The fingerprint alone is NOT the restart decision. It compares this run's
# disk to this run's disk, which says nothing about what the RUNNING connector
# loaded. The decision below also asks the running connector what it serves and
# compares that to the render, so a box already sitting on a stale config
# self-heals on the next apply even when no file byte moved.
SUM_BEFORE=$(fingerprint_connector_inputs)
if ! ./render.sh; then
  echo "FAILED: render.sh could not render the config for ${REMOTE:0:7} (its message is" >&2
  echo "above). If it names a missing .env variable, add it -- deploy/.env.example lists" >&2
  echo "every required one, with the devnet preset for settlement. deploy/.applied is" >&2
  echo "left naming the last commit that DID apply, so this is retried, and reported the" >&2
  echo "same way, on every run, until it is fixed." >&2
  exit 1
fi
SUM_AFTER=$(fingerprint_connector_inputs)

COMPOSE=(-f docker-compose.yml)

# Captured before `up -d` so a recreation is distinguishable: a recreated
# connector already booted on the just-rendered files and must not be bounced a
# second time for the same change.
CONNECTOR_BEFORE_UP=$(docker compose "${COMPOSE[@]}" ps -q connector || true)

# Every service is a published image (TOON_Network#155), pulled by the pin
# docker-compose.yml names. No `--ignore-*` flags: a pull that fails is a real
# problem (a bad pin, an unpublished tag, GHCR unreachable) and this fails
# loudly on it rather than bring up a stale container. The one exception is
# pull-images.sh's: while the gateway pin is still the sha-0000000
# placeholder, that image is built from the checkout just fast-forwarded.
if ! ./pull-images.sh; then
  echo "FAILED: pull-images.sh could not get the images for ${REMOTE:0:7} (its message is" >&2
  echo "above). deploy/.applied is left naming the last commit that DID apply, so this is" >&2
  echo "retried, and reported the same way, on every run, until it is fixed." >&2
  exit 1
fi
if ! docker compose "${COMPOSE[@]}" up -d; then
  echo "FAILED: 'docker compose up -d' failed for ${REMOTE:0:7} (its message is above)." >&2
  exit 1
fi

# A service must reach `healthy`. Docker resets Health.Status to `starting` on
# restart, so calling this right after a restart cannot read a stale `healthy`.
wait_healthy() {
  local service=$1 container status
  container=$(docker compose "${COMPOSE[@]}" ps -q "$service")
  for _ in $(seq 1 40); do
    status=$(docker inspect "$container" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}')
    [ "$status" = healthy ] && return 0
    sleep 3
  done
  echo "FAILED: $service is '${status:-unknown}' after applying ${REMOTE:0:7}."
  docker compose "${COMPOSE[@]}" logs --tail 40 "$service" || true
  return 1
}

# The gateway first: the connector's own healthcheck says nothing about whether
# the door behind it answers, and a newly-pulled gateway is the change most likely
# to have gone wrong.
wait_healthy gateway || exit 1
wait_healthy connector || exit 1

# Ask the RUNNING connector what it advertises (GET /ilp, unauthenticated, on
# the loopback-published port from docker-compose.yml). Only the ilpAddresses
# array: the body also lists routes[].prefix, and comparing anything wider
# would fail every healthy apply. The body is whitespace-stripped first so a
# pretty-printed answer parses the same as a compact one, and only the FIRST
# ilpAddresses occurrence is read.
#
# A curl failure is a FAILURE of this function (distinct exit), never an empty
# address list: an unreachable /ilp must be reported as unreachable, not as a
# config mismatch. The curl retries first so one connection blip does not leave
# the box unverified until the next merge.
ILP_PORT=$({ sed -n "s/.*'127\.0\.0\.1:\([0-9]*\):[0-9]*'.*/\1/p" docker-compose.yml | head -n 1; } || true)
ILP_PORT=${ILP_PORT:-4000}
served_ilp_addresses() {
  local body
  body=$(curl -fsS --retry 3 --retry-delay 2 --retry-all-errors --max-time 10 \
    "http://127.0.0.1:${ILP_PORT}/ilp") || return 1
  printf '%s' "$body" | tr -d ' \t\r\n' \
    | grep -o '"ilpAddresses":\[[^]]*\]' | head -n 1 \
    | sed 's/^"ilpAddresses"://' \
    | grep -o '"[^"]*"' | tr -d '"' | sort -u || true
}

WANT=$(advertised_addresses connector.toml)
if [ -z "$WANT" ]; then
  echo "FAILED: parsed no addresses out of the rendered connector.toml's [node] block."
  echo "The activation check below would pass vacuously; fix the template or the parser."
  exit 1
fi

if ! GOT=$(served_ilp_addresses); then
  echo "FAILED: GET /ilp on 127.0.0.1:${ILP_PORT} is unreachable while the connector reports healthy."
  docker compose "${COMPOSE[@]}" logs --tail 40 connector || true
  exit 1
fi

# Restart when the rendered inputs changed (unless `up -d` already recreated
# the container, which booted it on the new files), OR when the running
# connector serves addresses that disagree with the render.
#
# ── What a connector restart costs here, and why it is still right ───────────
# It costs nothing a tenant notices. The GRANTS live in the gateway, which is
# not touched; the connector holds only the claim watermark, and that is on a
# named volume. A handover in flight during the bounce is refused and re-sent.
CONNECTOR_AFTER_UP=$(docker compose "${COMPOSE[@]}" ps -q connector)
NEEDS_RESTART=0
if [ "$SUM_AFTER" != "$SUM_BEFORE" ] && [ "$CONNECTOR_AFTER_UP" = "$CONNECTOR_BEFORE_UP" ]; then
  echo "the connector's rendered inputs changed; restarting it to activate them"
  NEEDS_RESTART=1
fi
if [ "$GOT" != "$WANT" ]; then
  echo "the running connector serves addresses that differ from the rendered config; restarting it"
  NEEDS_RESTART=1
fi

if [ "$NEEDS_RESTART" = 1 ]; then
  # Bounce the connector and ONLY it: nothing else changed, and nginx in
  # particular must outlive the others -- it holds the certificate.
  docker compose "${COMPOSE[@]}" restart connector
  wait_healthy connector || exit 1
  if ! GOT=$(served_ilp_addresses); then
    echo "FAILED: GET /ilp on 127.0.0.1:${ILP_PORT} is unreachable after restarting for activation."
    docker compose "${COMPOSE[@]}" logs --tail 40 connector || true
    exit 1
  fi
fi

# Both directions, so a stale extra name fails too.
if [ "$GOT" != "$WANT" ]; then
  echo "FAILED: the running connector does not serve the rendered config, even after restarting."
  echo "rendered [node].addresses:"
  printf '%s\n' "$WANT" | sed 's/^/  /'
  echo "addresses served by GET /ilp:"
  printf '%s\n' "$GOT" | sed 's/^/  /'
  docker compose "${COMPOSE[@]}" logs --tail 40 connector || true
  exit 1
fi

# nginx holds the rendered server names and is NOT recreated by a bind-mount
# change either. It is never restarted -- restarting the TLS front is what the
# other bundles go out of their way to avoid -- so tell it to reload instead,
# which re-reads conf.d and the certificate without dropping a connection.
if [ "$SUM_AFTER" != "$SUM_BEFORE" ] || ! cmp -s nginx/conf.d/node.conf nginx/conf.d/.node.conf.applied 2>/dev/null; then
  docker compose "${COMPOSE[@]}" exec -T nginx nginx -s reload \
    && cp nginx/conf.d/node.conf nginx/conf.d/.node.conf.applied \
    || echo "::warning:: nginx would not reload; check its logs."
fi

# Written only now, after render, the pulls, `up -d`, both health waits and
# the activation check have all succeeded -- the one thing this file is
# allowed to claim. Gitignored (deploy/.gitignore).
printf '%s\n' "$REMOTE" > "$APPLIED_FILE"

echo "applied ${REMOTE:0:7}; gateway and connector healthy, rendered config verified live."
