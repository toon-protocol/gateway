// init-letsencrypt.sh, run for real against a stub `docker` (which answers
// for the `certbot` container the same way pull-images.test.mjs's stub
// answers for images) and stub `getent`/`hostname` (so the pre-issue DNS
// check is deterministic and needs no real network or root).
//
// TOON_Network#163: a failed certificate used to be a `::warning::` this
// script swallowed -- bootstrap.sh went on to print "Workload Gateway box
// up." on a box serving no valid certificate, which the gateway's own README
// calls a worse state than one that refused to start. Now:
//   * issuance failure exits non-zero, naming the DNS_PROVIDER credentials or
//     zone as the likely cause (DNS-01's own failure mode);
//   * a pre-issue check warns (never blocks -- DNS-01 does not need this) when
//     the wildcard (`anything.<GATEWAY_DOMAIN>`) or `EDGE_HOST` do not resolve
//     to this box yet;
//   * an existing, still-valid certificate is reused without going near
//     either of the above, so the devnet box's idempotent re-runs stay green.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'init-letsencrypt.sh');

const ENV = {
  GATEWAY_DOMAIN: 'gw.fixture.example',
  EDGE_HOST: 'proxy.gateway.fixture.example',
  LETSENCRYPT_EMAIL: 'ops@fixture.example',
  DNS_PROVIDER: 'porkbun',
  LETSENCRYPT_STAGING: '1',
};

// A `docker` that answers the three shapes of `compose run --rm --entrypoint
// sh certbot -c "<script>"` this file makes (matched by a marker unique to
// each, since all three share the same call shape) plus the certonly request
// and the ordinary compose calls around it.
const DOCKER_STUB = `#!/usr/bin/env bash
echo "$*" >> "$STUB_LOG"
if [ "\${1:-}" = compose ]; then
  shift
  case "$1 $2 $3" in
    "up -d nginx") exit 0 ;;
    "exec nginx nginx") exit "\${STUB_RELOAD_EXIT:-0}" ;;
  esac
  if [ "$1 $2 $3 $4" = "run --rm --entrypoint sh" ]; then
    script="\${@: -1}"
    case "$script" in
      *checkend*) printf '%s' "\${STUB_EXISTING_CERT_OK:-}"; exit 0 ;;
      *"openssl req -x509"*) exit 0 ;;
      *"rm -rf /etc/letsencrypt"*) exit 0 ;;
    esac
    echo "stub docker: unexpected certbot -c script: $script" >&2
    exit 97
  fi
  if [ "$1 $2 $3 $4" = "run --rm --entrypoint certbot" ]; then
    exit "\${STUB_CERTONLY_EXIT:-0}"
  fi
  echo "stub docker: unexpected compose call: $*" >&2
  exit 97
fi
echo "stub docker: unexpected call: $*" >&2
exit 97
`;

// A `getent ahostsv4 <name>` that answers from STUB_RESOLVE_<name, dots and
// dashes as underscores>, or nothing (NXDOMAIN-shaped: no stdout, exit 2) when
// that variable is unset or empty -- exactly `getent`'s real behaviour for a
// name that does not resolve.
const GETENT_STUB = `#!/usr/bin/env bash
if [ "\${1:-}" = ahostsv4 ]; then
  key="STUB_RESOLVE_\$(printf '%s' "$2" | tr '.-' '__')"
  ip="\${!key:-}"
  if [ -n "$ip" ]; then printf '%s STREAM %s\\n' "$ip" "$2"; exit 0; fi
  exit 2
fi
echo "stub getent: unexpected call: $*" >&2
exit 97
`;

const HOSTNAME_STUB = `#!/usr/bin/env bash
if [ "\${1:-}" = -I ]; then printf '%s\\n' "\${STUB_MY_IPS:-}"; exit 0; fi
echo "stub hostname: unexpected call: $*" >&2
exit 97
`;

const stubBin = mkdtempSync(join(tmpdir(), 'gateway-init-le-bin-'));
after(() => rmSync(stubBin, { recursive: true, force: true }));
for (const [name, content] of [
  ['docker', DOCKER_STUB],
  ['getent', GETENT_STUB],
  ['hostname', HOSTNAME_STUB],
]) {
  const path = join(stubBin, name);
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

const scratch = [];
after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** One run of the real init-letsencrypt.sh, in a scratch bundle directory. */
function initLetsencrypt({
  env = {},
  myIps = '203.0.113.9',
  existingCertOk = '',
  certonlyExit = 0,
  resolve = {},
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gateway-init-le-run-'));
  scratch.push(dir);
  writeFileSync(join(dir, 'init-letsencrypt.sh'), readFileSync(SCRIPT));
  chmodSync(join(dir, 'init-letsencrypt.sh'), 0o755);
  mkdirSync(join(dir, 'certbot'), { recursive: true });
  writeFileSync(join(dir, 'certbot', 'porkbun.py'), '# fixture hook\n');
  writeFileSync(join(dir, 'dns-01.env'), '');
  const dotenv = Object.entries({ ...ENV, ...env })
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  writeFileSync(join(dir, '.env'), `${dotenv}\n`);

  const log = join(dir, 'stub-log');
  writeFileSync(log, '');
  const resolveEnv = {};
  for (const [name, ip] of Object.entries(resolve)) {
    resolveEnv[`STUB_RESOLVE_${name.replace(/[.-]/g, '_')}`] = ip;
  }
  const r = spawnSync('bash', ['./init-letsencrypt.sh'], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${stubBin}:${process.env.PATH}`,
      STUB_LOG: log,
      STUB_MY_IPS: myIps,
      STUB_EXISTING_CERT_OK: existingCertOk,
      STUB_CERTONLY_EXIT: String(certonlyExit),
      ...resolveEnv,
    },
  });
  const status = r.status ?? -1;
  const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean);
  return { status, stdout: r.stdout, stderr: r.stderr, calls };
}

describe('init-letsencrypt.sh', () => {
  it('reuses an existing valid certificate without running the DNS check or issuing', () => {
    const r = initLetsencrypt({ existingCertOk: 'ok' });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /::warning::/, 'reuse must not run the pre-issue DNS check');
    assert.equal(
      r.calls.some((c) => c.startsWith('compose run --rm --entrypoint certbot')),
      false,
      'reuse must never call certonly -- this is what keeps the devnet box\'s idempotent re-runs green',
    );
  });

  it('issues cleanly and exits 0 when the wildcard and edge host resolve here, with no warning', () => {
    const r = initLetsencrypt({
      myIps: '203.0.113.9',
      resolve: {
        'anything.gw.fixture.example': '203.0.113.9',
        'proxy.gateway.fixture.example': '203.0.113.9',
      },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /::warning::/);
    assert.match(r.stdout, /Done\./);
  });

  it('warns but still issues when the wildcard and edge host do not resolve here yet', () => {
    const r = initLetsencrypt({}); // nothing configured to resolve
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /::warning::.*anything\.gw\.fixture\.example.*does not resolve/);
    assert.match(r.stdout, /::warning::.*proxy\.gateway\.fixture\.example.*does not resolve/);
    assert.ok(
      r.calls.some((c) => c.startsWith('compose run --rm --entrypoint certbot')),
      'a DNS warning must not block issuance -- DNS-01 does not need it',
    );
  });

  it('warns when a name resolves to a different box entirely', () => {
    const r = initLetsencrypt({
      myIps: '203.0.113.9',
      resolve: { 'anything.gw.fixture.example': '198.51.100.1' },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /::warning::.*anything\.gw\.fixture\.example resolves to 198\.51\.100\.1/);
  });

  it('exits non-zero naming DNS_PROVIDER when issuance itself fails, and reseeds a dummy so nginx still answers', () => {
    const r = initLetsencrypt({ certonlyExit: 1 });
    assert.notEqual(r.status, 0, 'a failed issuance must fail the script');
    assert.match(r.stderr, /Certificate issuance failed/);
    assert.match(r.stderr, /porkbun/, 'must name the DNS_PROVIDER as the likely cause');
    assert.ok(
      r.calls.some((c) => c.startsWith('compose exec nginx nginx')),
      'nginx must still be reloaded onto the reseeded dummy so it keeps answering',
    );
  });

  it('does not fail when the local-address probe cannot tell (hostname -I unsupported)', () => {
    const r = initLetsencrypt({ myIps: '' });
    assert.equal(r.status, 0, r.stderr);
  });

  it('staging vs production is unaffected: production still requests without --staging', () => {
    const r = initLetsencrypt({ env: { LETSENCRYPT_STAGING: '0' }, existingCertOk: '' });
    assert.equal(r.status, 0, r.stderr);
    const certonly = r.calls.find((c) => c.startsWith('compose run --rm --entrypoint certbot'));
    assert.ok(certonly, 'expected a certonly call');
    assert.doesNotMatch(certonly, /--staging/);
  });

  it('SHARED_EDGE=1: issues nothing and never touches docker at all (toon-protocol/gateway#18)', () => {
    // The devnet host's shared edge terminates TLS; this box has no nginx or
    // certbot to seed, reload or issue into, so the real assertion is that
    // this script never calls docker at all -- not merely that it declines
    // to request a certificate.
    const r = initLetsencrypt({ env: { SHARED_EDGE: '1' } });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /SHARED_EDGE=1/);
    assert.match(r.stdout, /toon-protocol\/infra#24/);
    assert.deepEqual(r.calls, [], 'init-letsencrypt.sh called docker under SHARED_EDGE=1');
  });
});

describe('bootstrap.sh stops on a failed certificate', () => {
  it('wraps the call in an if, and names the re-run command on failure', () => {
    const bootstrap = readFileSync(join(HERE, 'bootstrap.sh'), 'utf8');
    assert.match(bootstrap, /if\s*!\s*\.\/init-letsencrypt\.sh\s*;\s*then/);
    assert.match(bootstrap, /FAILED:.*certificate/i);
    assert.match(bootstrap, /init-letsencrypt\.sh/);
    assert.match(bootstrap, /exit 1/);
  });
});
