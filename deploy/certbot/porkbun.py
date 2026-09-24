#!/usr/bin/env python3
"""Porkbun DNS-01 hooks for certbot, with no plugin and no extra image.

This box needs a WILDCARD certificate — every workload is served at a label
under the gateway's domain that nobody can enumerate — and Let's Encrypt issues
a wildcard over DNS-01 only. Every other bundle in this fleet uses HTTP-01 and
needs none of this.

certbot is a Python program, so its stock image already has the one thing this
needs: a Python interpreter and `urllib`. That is why this is a script mounted
into `certbot/certbot` rather than a plugin baked into an image of our own —
an image we build is an image we have to publish, pin and remember to rebuild,
for two API calls.

Used as:

    certbot certonly --manual --preferred-challenges dns \
        --manual-auth-hook    'python3 /opt/hooks/porkbun.py auth' \
        --manual-cleanup-hook 'python3 /opt/hooks/porkbun.py cleanup' ...

certbot records both commands in the renewal configuration, so `certbot renew`
re-runs them unattended — which is the whole point: a wildcard has to be
renewed the same way it was issued, and nobody is here to edit DNS by hand
every sixty days.

Environment (render.sh passes every PORKBUN_* line of .env, via dns-01.env):
  PORKBUN_API_KEY     the API key
  PORKBUN_SECRET_KEY  its secret half
  PORKBUN_ZONE        the REGISTERED domain, e.g. `toonprotocol.dev`. Porkbun's
                      API is addressed by zone, and a subdomain is not one:
                      `dns/create/gw.devnet.toonprotocol.dev` answers
                      "Invalid domain".

certbot supplies CERTBOT_DOMAIN (the base name, never the `*.` form) and
CERTBOT_VALIDATION (the token to publish).

Neither key is ever printed. Failures name the call, not the credential.
"""

import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

API = "https://api.porkbun.com/api/json/v3"
DOH = "https://dns.google/resolve"

# Where the created record's id is remembered between the auth hook and the
# cleanup hook — two separate processes. Deleting BY ID rather than deleting
# every `_acme-challenge` TXT matters when a certificate covers both `x` and
# `*.x`: those are two challenges on ONE record name, live at the same moment,
# and a cleanup that deleted by name would pull the other one's token out from
# under it mid-validation.
STATE_DIR = "/etc/letsencrypt/porkbun-dns01"

# Porkbun's minimum. The record is created fresh each time, so a resolver has
# nothing stale of its own to hold.
TTL = "600"

# How long to wait for the record to be visible before handing back to certbot.
# A validation that starts too early fails the whole issuance, and Let's
# Encrypt's failure budget is small, so this waits rather than hoping.
PROPAGATION_TIMEOUT_S = 300
PROPAGATION_POLL_S = 10


def fail(message):
    print("porkbun-dns01: " + message, file=sys.stderr)
    sys.exit(1)


def env(name):
    value = os.environ.get(name, "").strip()
    if not value:
        fail("%s is not set" % name)
    return value


def api(path, payload):
    """One Porkbun JSON call. Returns the decoded body, or exits."""
    body = dict(payload)
    body["apikey"] = env("PORKBUN_API_KEY")
    body["secretapikey"] = env("PORKBUN_SECRET_KEY")
    request = urllib.request.Request(
        API + path,
        data=json.dumps(body).encode(),
        headers={"content-type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as answer:
            decoded = json.loads(answer.read().decode())
    except urllib.error.URLError as problem:
        # `problem` can carry the request body in some urllib versions, and
        # that body holds the credentials. Report the path and the reason only.
        fail("POST %s failed: %s" % (path, problem.__class__.__name__))
    if decoded.get("status") != "SUCCESS":
        fail("POST %s answered %s: %s" % (path, decoded.get("status"), decoded.get("message")))
    return decoded


def record_name(domain, zone):
    """The record name RELATIVE to the zone, which is what Porkbun wants.

    `_acme-challenge` under `gw.devnet.toonprotocol.dev` in the zone
    `toonprotocol.dev` is the record `_acme-challenge.gw.devnet`.
    """
    domain = domain.rstrip(".").lower()
    zone = zone.rstrip(".").lower()
    if domain == zone:
        return "_acme-challenge"
    if not domain.endswith("." + zone):
        fail("%s is not under the zone %s — check PORKBUN_ZONE" % (domain, zone))
    return "_acme-challenge." + domain[: -(len(zone) + 1)]


def fqdn(domain):
    return "_acme-challenge." + domain.rstrip(".").lower()


def state_path(domain):
    os.makedirs(STATE_DIR, exist_ok=True)
    return os.path.join(STATE_DIR, domain.rstrip(".").lower() + ".ids")


def visible(name, value):
    """Is `value` among the TXT records public DNS answers with for `name`?

    Asked over DNS-over-HTTPS so this needs no resolver tooling in the image.
    `cd=1` disables DNSSEC validation, which a just-created record in a signed
    zone can briefly fail.
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
    zone = env("PORKBUN_ZONE")
    name = record_name(domain, zone)

    created = api(
        "/dns/create/" + zone,
        {"name": name, "type": "TXT", "content": validation, "ttl": TTL},
    )
    # Append: a certificate covering both `x` and `*.x` runs this hook twice
    # for the same name, and both ids must survive to cleanup.
    with open(state_path(domain), "a", encoding="utf-8") as handle:
        handle.write("%s\n" % created["id"])
    print("porkbun-dns01: published TXT %s.%s" % (name, zone), file=sys.stderr)

    deadline = time.time() + PROPAGATION_TIMEOUT_S
    while time.time() < deadline:
        if visible(fqdn(domain), validation):
            print("porkbun-dns01: %s is visible" % fqdn(domain), file=sys.stderr)
            return
        time.sleep(PROPAGATION_POLL_S)
    # Hand back anyway rather than failing outright: the record exists, and a
    # validation that succeeds despite an impatient poll is better than an
    # issuance abandoned because one resolver was slow. Say so loudly.
    print(
        "porkbun-dns01: WARNING %s did not become visible within %ds; "
        "letting the validation try anyway" % (fqdn(domain), PROPAGATION_TIMEOUT_S),
        file=sys.stderr,
    )


def cleanup():
    domain = env("CERTBOT_DOMAIN")
    zone = env("PORKBUN_ZONE")
    path = state_path(domain)
    if not os.path.exists(path):
        # Nothing to undo. A cleanup with no auth behind it is not an error —
        # certbot runs this after a failure too.
        return
    with open(path, encoding="utf-8") as handle:
        ids = [line.strip() for line in handle if line.strip()]
    os.remove(path)
    for record_id in ids:
        api("/dns/delete/%s/%s" % (zone, record_id), {})
        print("porkbun-dns01: deleted TXT record %s" % record_id, file=sys.stderr)


if __name__ == "__main__":
    if len(sys.argv) != 2 or sys.argv[1] not in ("auth", "cleanup"):
        fail("usage: porkbun.py auth|cleanup")
    if sys.argv[1] == "auth":
        auth()
    else:
        cleanup()
