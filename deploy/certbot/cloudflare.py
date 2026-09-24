#!/usr/bin/env python3
"""Cloudflare DNS-01 hooks for certbot, with no plugin and no extra image.

The second provider behind the same hook interface as porkbun.py, whose
docstring has the reasoning this one shares: this box needs a WILDCARD
certificate, Let's Encrypt issues a wildcard over DNS-01 only, and the stock
`certbot/certbot` image already has a Python interpreter and `urllib` — so a
script mounted into it beats a plugin baked into an image we would have to
publish, pin and rebuild for three API calls. README.md § "DNS-01" is the
interface; this file is one instance of it and imports nothing from any other
hook, because certbot stores `python3 /opt/hooks/cloudflare.py ...` in the
lineage's renewal configuration and that command has to keep working on its
own for as long as the lineage lives.

Used as (init-letsencrypt.sh builds these from DNS_PROVIDER=cloudflare):

    certbot certonly --manual --preferred-challenges dns \
        --manual-auth-hook    'python3 /opt/hooks/cloudflare.py auth' \
        --manual-cleanup-hook 'python3 /opt/hooks/cloudflare.py cleanup' ...

Environment (render.sh passes every CLOUDFLARE_* line of .env, via dns-01.env):
  CLOUDFLARE_API_TOKEN  an API TOKEN, not the global API key: create one with
                        the "Edit zone DNS" template, scoped to the one zone.
                        That is Zone:DNS:Edit, which is all this needs.
  CLOUDFLARE_ZONE       the REGISTERED domain, e.g. `example.com` — the zone
                        the gateway's domain lives in. Looked up to its id.
  CLOUDFLARE_ZONE_ID    optional: the zone's id, from the zone's Overview
                        page. Given, the lookup is skipped.

certbot supplies CERTBOT_DOMAIN (the base name, never the `*.` form) and
CERTBOT_VALIDATION (the token to publish).

The token is never printed. Failures name the call and Cloudflare's own error
codes, not the credential.
"""

import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

API = "https://api.cloudflare.com/client/v4"
DOH = "https://dns.google/resolve"

# Where the created record's id is remembered between the auth hook and the
# cleanup hook — two separate processes. Deleted BY ID, for the reason
# porkbun.py gives: a certificate covering `x` and `*.x` has two challenges
# live on ONE record name at the same moment.
STATE_DIR = "/etc/letsencrypt/cloudflare-dns01"

# The lowest TTL Cloudflare accepts on a non-Enterprise zone. The record is
# created fresh each time, so there is nothing stale for a resolver to hold.
TTL = 120

# See porkbun.py: a validation that starts too early fails the whole issuance,
# and Let's Encrypt's failure budget is small, so this waits rather than hopes.
PROPAGATION_TIMEOUT_S = 300
PROPAGATION_POLL_S = 10


def fail(message):
    print("cloudflare-dns01: " + message, file=sys.stderr)
    sys.exit(1)


def env(name, required=True):
    value = os.environ.get(name, "").strip()
    if required and not value:
        fail("%s is not set" % name)
    return value


def api(method, path, payload=None):
    """One Cloudflare v4 call. Returns the decoded `result`, or exits."""
    request = urllib.request.Request(
        API + path,
        data=None if payload is None else json.dumps(payload).encode(),
        headers={
            "authorization": "Bearer " + env("CLOUDFLARE_API_TOKEN"),
            "content-type": "application/json",
        },
        method=method,
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as answer:
            decoded = json.loads(answer.read().decode())
    except urllib.error.HTTPError as problem:
        # A 4xx from Cloudflare still carries the v4 envelope, whose `errors`
        # say what was wrong (a token without DNS:Edit is code 10000). The
        # body is Cloudflare's, so it holds no credential of ours.
        try:
            decoded = json.loads(problem.read().decode())
        except Exception:
            fail("%s %s answered HTTP %s" % (method, path, problem.code))
    except urllib.error.URLError as problem:
        # Never the exception's text: the request it describes carries the
        # token in a header.
        fail("%s %s failed: %s" % (method, path, problem.__class__.__name__))
    if not decoded.get("success"):
        errors = "; ".join(
            "%s %s" % (row.get("code"), row.get("message")) for row in decoded.get("errors", [])
        )
        fail("%s %s was refused: %s" % (method, path, errors or "no error given"))
    return decoded.get("result")


def zone_id():
    given = env("CLOUDFLARE_ZONE_ID", required=False)
    if given:
        return given
    zone = env("CLOUDFLARE_ZONE").rstrip(".").lower()
    found = api("GET", "/zones?" + urllib.parse.urlencode({"name": zone}))
    if not found:
        fail("no zone named %s is visible to this token — check CLOUDFLARE_ZONE "
             "(the registered domain) and the token's zone scope" % zone)
    return found[0]["id"]


def fqdn(domain):
    """The record name. Cloudflare takes it fully qualified, unlike Porkbun."""
    domain = domain.rstrip(".").lower()
    zone = env("CLOUDFLARE_ZONE", required=False).rstrip(".").lower()
    if zone and domain != zone and not domain.endswith("." + zone):
        fail("%s is not under the zone %s — check CLOUDFLARE_ZONE" % (domain, zone))
    return "_acme-challenge." + domain


def state_path(domain):
    os.makedirs(STATE_DIR, exist_ok=True)
    return os.path.join(STATE_DIR, domain.rstrip(".").lower() + ".ids")


def visible(name, value):
    """Is `value` among the TXT records public DNS answers with for `name`?

    The same DNS-over-HTTPS check porkbun.py makes, copied rather than shared
    so that each hook is one file (see the docstring).
    """
    url = "%s?name=%s&type=TXT&cd=1" % (DOH, urllib.parse.quote(name))
    try:
        with urllib.request.urlopen(url, timeout=15) as answer:
            decoded = json.loads(answer.read().decode())
    except Exception:
        return False
    for row in decoded.get("Answer", []):
        if row.get("type") != 16:
            continue
        if value in row.get("data", "").replace('"', ""):
            return True
    return False


def auth():
    domain = env("CERTBOT_DOMAIN")
    validation = env("CERTBOT_VALIDATION")
    name = fqdn(domain)
    zone = zone_id()

    created = api(
        "POST",
        "/zones/%s/dns_records" % zone,
        {"type": "TXT", "name": name, "content": validation, "ttl": TTL},
    )
    # Append, with the zone: a certificate covering both `x` and `*.x` runs
    # this hook twice for the same name, and cleanup must not look the zone up
    # again with a token that may have been rotated in between.
    with open(state_path(domain), "a", encoding="utf-8") as handle:
        handle.write("%s %s\n" % (zone, created["id"]))
    print("cloudflare-dns01: published TXT %s" % name, file=sys.stderr)

    deadline = time.time() + PROPAGATION_TIMEOUT_S
    while time.time() < deadline:
        if visible(name, validation):
            print("cloudflare-dns01: %s is visible" % name, file=sys.stderr)
            return
        time.sleep(PROPAGATION_POLL_S)
    print(
        "cloudflare-dns01: WARNING %s did not become visible within %ds; "
        "letting the validation try anyway" % (name, PROPAGATION_TIMEOUT_S),
        file=sys.stderr,
    )


def cleanup():
    domain = env("CERTBOT_DOMAIN")
    path = state_path(domain)
    if not os.path.exists(path):
        # Nothing to undo. certbot runs cleanup after a failed auth too.
        return
    with open(path, encoding="utf-8") as handle:
        rows = [line.split() for line in handle if line.strip()]
    os.remove(path)
    for zone, record_id in rows:
        api("DELETE", "/zones/%s/dns_records/%s" % (zone, record_id))
        print("cloudflare-dns01: deleted TXT record %s" % record_id, file=sys.stderr)


if __name__ == "__main__":
    if len(sys.argv) != 2 or sys.argv[1] not in ("auth", "cleanup"):
        fail("usage: cloudflare.py auth|cleanup")
    if sys.argv[1] == "auth":
        auth()
    else:
        cleanup()
