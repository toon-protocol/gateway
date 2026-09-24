#!/usr/bin/env bash
# Get the images docker-compose.yml pins onto this box.
#
#   ./pull-images.sh              every service
#   ./pull-images.sh gateway      only the ones named
#
# A pinned image is PULLED, and a pull that fails is a failure: a bad pin, an
# unpublished tag or an unreachable registry must stop an apply loudly rather
# than leave a stale container running (TOON_Network#155).
#
# ── The one exception: the placeholder pin ─────────────────────────────────
# Until publish-gateway-image.yml has published its first `sha-<short>`, the
# `gateway` line in docker-compose.yml reads `sha-0000000`, which names nothing
# on GHCR. For exactly that tag, and only for the one image this repository
# builds, the image is BUILT from this checkout and tagged with the pinned
# name, so compose finds it locally and never asks the registry. Once the pin
# is a real published tag, none of this runs and the box only pulls.
#
# Same name and behaviour as the provider bundle's deploy/pull-images.sh.
set -euo pipefail
cd "$(dirname "$0")"

PLACEHOLDER=sha-0000000

# The Dockerfile each self-built service comes from, relative to the repo
# root, which is its build context.
dockerfile_for() {
  case "$1" in
    gateway) echo Dockerfile ;;
    *) return 1 ;;
  esac
}

if [ "$#" -gt 0 ]; then
  services=("$@")
else
  mapfile -t services < <(docker compose config --services)
fi

pull=()
for service in "${services[@]}"; do
  image=$(docker compose config --images "$service")
  if [ "${image##*:}" = "$PLACEHOLDER" ] && dockerfile=$(dockerfile_for "$service"); then
    echo "::warning:: $image is the placeholder pin (nothing published yet); building $service from this checkout instead." >&2
    docker build --quiet -t "$image" -f "../$dockerfile" .. >&2
  else
    pull+=("$service")
  fi
done

if [ "${#pull[@]}" -gt 0 ]; then
  docker compose pull --quiet "${pull[@]}" >&2
fi
