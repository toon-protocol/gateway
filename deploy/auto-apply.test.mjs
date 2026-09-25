// auto-apply.sh, run for real -- against a real git remote and a real box
// checkout, with `docker` and `curl` stubbed on PATH (the same style
// pull-images.test.mjs uses) so the box never needs a live daemon or a live
// gateway to prove what THIS script does with what they answer.
//
// TOON_Network#160: a render (or apply) failure after a fast-forward used to
// be invisible on the NEXT run -- `git fetch` brought back nothing new, so
// "LOCAL = REMOTE" alone read as "nothing to do", and the box sat on the new
// commit with the OLD rendered config and containers, reporting success
// forever. `deploy/.applied` (gitignored) is the fix: it names the last
// commit a run actually finished applying AND verifying, written only at the
// very end, so the NEXT run compares HEAD to that -- not to what fetch just
// brought back -- and retries, and reports, the exact same failure on every
// run until it is fixed.
//
// The fixture below is the one the issue asks for: a render that fails once
// after a fast-forward (a newly-required .env variable, same shape as
// TOON_Network#152's), retried and reported loudly by the very next run even
// though that run's `git fetch` brings back nothing new, and finally applied
// once the variable is added -- at which point `.applied` is written. A
// second describe block covers the box that has never written `.applied` at
// all: an existing box's first run under this check, which this script reads
// as "needs an apply", not "must already be applied" (see auto-apply.sh's own
// comment on the choice).
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

const HERE = dirname(fileURLToPath(import.meta.url));
const envExample = readFileSync(join(HERE, '.env.example'), 'utf8');

// An operator who is not the devnet box: their own address, their own DNS
// provider. Nothing here is `g.toon.`, so TOON_DEVNET_BOX is never needed.
const ENV = {
  ILP_ADDRESS: 'g.fixture.workload-gateway',
  GATEWAY_DOMAIN: 'gw.fixture.example',
  EDGE_HOST: 'proxy.gateway.fixture.example',
  DNS_PROVIDER: 'porkbun',
  PORKBUN_ZONE: 'fixture.example',
  PORKBUN_API_KEY: 'pk-fixture',
  PORKBUN_SECRET_KEY: 'sk-fixture',
  OPERATOR_BEARER_TOKEN: 'fixture-bearer-token',
  OPERATOR_WRITE_KEY: 'fixture-write-key',
};

const scratch = [];
after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function tmp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} in ${cwd}:\n${r.stderr}`);
  return r.stdout;
}

function commitAll(dir, message) {
  git(['add', '-A'], dir);
  git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '--no-gpg-sign', '-m', message], dir);
  return git(['rev-parse', 'HEAD'], dir).trim();
}

// A repository shaped like the real one: `deploy/` under the repo root, since
// that is what auto-apply.sh's own `dirname "$0")/..` assumes.
function freshOrigin() {
  const dir = tmp('gateway-origin-');
  const deploy = join(dir, 'deploy');
  mkdirSync(deploy, { recursive: true });
  for (const name of [
    'render.sh',
    'pull-images.sh',
    'auto-apply.sh',
    'connector.toml.template',
    '.env.example',
    '.gitignore',
    'docker-compose.yml',
    'nginx',
    'certbot',
  ]) {
    cpSync(join(HERE, name), join(deploy, name), { recursive: true });
  }
  for (const name of ['render.sh', 'pull-images.sh', 'auto-apply.sh']) {
    chmodSync(join(deploy, name), 0o755);
  }
  git(['init', '--quiet', '-b', 'main'], dir);
  const sha = commitAll(dir, 'bundle');
  return { dir, sha };
}

function cloneBox(originDir) {
  const dir = tmp('gateway-box-');
  git(['clone', '--quiet', originDir, dir], undefined);
  return dir;
}

/** A commit that adds a newly-required .env variable to render.sh -- the
 * exact shape of the regression TOON_Network#152 found: a fast-forward whose
 * render needs something the box's own .env does not have. */
function addFixtureRequiredVar(originDir) {
  const path = join(originDir, 'deploy', 'render.sh');
  const before = readFileSync(path, 'utf8');
  const marker = 'set -a; . ./.env; set +a\n';
  assert.ok(before.includes(marker), 'render.sh no longer sources .env the expected way');
  const after = before.replace(
    marker,
    `${marker}\n: "\${GATEWAY_FIXTURE_FLAG:?set GATEWAY_FIXTURE_FLAG in .env (deploy/.env.example lists every required variable; this one is a TOON_Network#160 test fixture)}"\n`,
  );
  writeFileSync(path, after);
  return commitAll(originDir, 'render.sh now needs GATEWAY_FIXTURE_FLAG');
}

function writeEnv(boxDir, values) {
  let env = envExample;
  for (const [name, value] of Object.entries(values)) {
    const line = new RegExp(`^#? ?${name}=.*$`, 'm');
    env = line.test(env) ? env.replace(line, `${name}=${value}`) : `${env}\n${name}=${value}\n`;
  }
  writeFileSync(join(boxDir, 'deploy', '.env'), env);
}

// ── The stubbed world: docker and curl on PATH ───────────────────────────────
// The same technique pull-images.test.mjs uses for docker, extended to every
// call auto-apply.sh itself makes (ps -q, up -d, restart, exec, logs,
// inspect), plus a curl stub that answers GET /ilp from whatever
// connector.toml auto-apply.sh just rendered in its own working directory --
// so a real render change is what a "different served address" would mean,
// not a canned response.
const DOCKER_STUB = `#!/usr/bin/env bash
echo "$*" >> "$STUB_LOG"
if [ "\${1:-}" = compose ]; then
  shift
  if [ "\${1:-}" = -f ]; then shift 2; fi
  rest="$*"
  case "$rest" in
    "config --services") printf '%s\\n' $STUB_SERVICES; exit 0 ;;
    "config --images "*)
      svc=\${rest#config --images }
      var="STUB_IMAGE_\${svc//-/_}"
      echo "\${!var}"
      exit 0
      ;;
    "pull --quiet "*) exit "\${STUB_PULL_EXIT:-0}" ;;
    "up -d") exit "\${STUB_UP_EXIT:-0}" ;;
    "ps -q "*) svc=\${rest#ps -q }; echo "cid-$svc"; exit 0 ;;
    "restart "*) exit "\${STUB_RESTART_EXIT:-0}" ;;
    "logs --tail 40 "*) exit 0 ;;
    "port connector 4000") echo "\${STUB_PORT:-}"; exit 0 ;;
    "exec -T nginx nginx -s reload") exit "\${STUB_NGINX_RELOAD_EXIT:-0}" ;;
  esac
  echo "stub docker: unexpected compose call: $rest" >&2
  exit 97
fi
if [ "\${1:-}" = build ]; then exit 0; fi
if [ "\${1:-}" = inspect ]; then echo "\${STUB_HEALTH:-healthy}"; exit 0; fi
echo "stub docker: unexpected call: $*" >&2
exit 97
`;

const CURL_STUB = `#!/usr/bin/env bash
url="\${@: -1}"
echo "curl $url" >> "$STUB_LOG"
case "$url" in
  http://127.0.0.1:*/ilp)
    addr=$(sed -n '/^\\[node\\]/,/^\\[/s/^[[:space:]]*addresses[[:space:]]*=[[:space:]]*\\[\\(.*\\)\\].*/\\1/p' connector.toml | head -n1)
    printf '{"ilpAddresses":[%s]}\\n' "$addr"
    exit 0
    ;;
esac
echo "stub curl: unexpected call: $*" >&2
exit 7
`;

let stubBin;
before(() => {
  stubBin = tmp('gateway-stub-bin-');
  writeFileSync(join(stubBin, 'docker'), DOCKER_STUB);
  writeFileSync(join(stubBin, 'curl'), CURL_STUB);
  chmodSync(join(stubBin, 'docker'), 0o755);
  chmodSync(join(stubBin, 'curl'), 0o755);
});

let runs = 0;
function autoApply(boxDir, extraEnv = {}) {
  const log = join(boxDir, `stub-log-${runs++}`);
  writeFileSync(log, '');
  const env = {
    ...process.env,
    PATH: `${stubBin}:${process.env.PATH}`,
    STUB_LOG: log,
    STUB_SERVICES: 'gateway connector nginx certbot',
    STUB_IMAGE_gateway: 'ghcr.io/toon-protocol/gateway:sha-0000000',
    STUB_IMAGE_connector: 'ghcr.io/toon-protocol/connector:rust-2026.09.11.1',
    // Never the real, root-owned /var/lock/toon-auto-apply-gateway.lock --
    // this is the one knob auto-apply.sh exposes purely for tests.
    TOON_AUTOAPPLY_LOCK: join(boxDir, '.autoapply.lock'),
    ...extraEnv,
  };
  const r = spawnSync('bash', [join(boxDir, 'deploy', 'auto-apply.sh')], { env, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, calls: readFileSync(log, 'utf8') };
}

function applied(boxDir) {
  try {
    return readFileSync(join(boxDir, 'deploy', '.applied'), 'utf8').trim();
  } catch {
    return null;
  }
}

function headSha(dir) {
  return git(['rev-parse', 'HEAD'], dir).trim();
}

describe('a render that fails once after a fast-forward (TOON_Network#160)', () => {
  it('is retried and reported on every run -- even one whose fetch brings back nothing new -- and applies once .env is fixed', () => {
    const origin = freshOrigin();
    const box = cloneBox(origin.dir);
    writeEnv(box, ENV);

    // Run 1: box is already on the only commit there is, and has never
    // written .applied. Treated as needing an apply (the safer of the two
    // readings), and it succeeds.
    const first = autoApply(box);
    assert.equal(first.status, 0, `run 1 (no .applied yet) should apply cleanly:\n${first.stdout}\n${first.stderr}`);
    assert.equal(applied(box), origin.sha);

    // The bundle moves on: render.sh now needs a variable this box's .env
    // does not have -- exactly TOON_Network#152's shape of regression.
    const brokenSha = addFixtureRequiredVar(origin.dir);

    // Run 2: the fetch brings back real work, the fast-forward succeeds, and
    // render.sh fails on the missing variable.
    const second = autoApply(box);
    assert.notEqual(second.status, 0, 'a render failure must fail the apply');
    assert.equal(headSha(box), brokenSha, 'the fast-forward still happens; only the render fails');
    assert.match(second.stderr, /GATEWAY_FIXTURE_FLAG/, "render.sh's own message must name the missing variable");
    assert.match(second.stderr, /FAILED: render\.sh/);
    assert.match(second.stderr, /\.env\.example/i, 'it must point at .env.example');
    assert.equal(applied(box), origin.sha, '.applied must still name the last commit that DID apply');

    // Run 3: nothing new to fetch (the box is already on the broken commit),
    // but HEAD still disagrees with .applied. Before TOON_Network#160 this
    // read as "nothing to do" and exited 0 silently; now it must retry, and
    // fail the same way, every time.
    const third = autoApply(box);
    assert.notEqual(third.status, 0, 'the SAME failure must be reported again on a fetch that brings back nothing new');
    assert.match(third.stdout, /retrying/, 'it should say it is retrying, not applying something new');
    assert.match(third.stderr, /GATEWAY_FIXTURE_FLAG/);
    assert.equal(applied(box), origin.sha, 'still untouched after a second failed run');

    // The operator fixes it exactly as the message says: add the variable to
    // their own .env.
    writeEnv(box, { ...ENV, GATEWAY_FIXTURE_FLAG: 'ok' });

    // Run 4: same commit, same "nothing to fetch" situation as run 3, but now
    // it applies -- because .applied still disagreed with HEAD, this run was
    // never going to be skipped.
    const fourth = autoApply(box);
    assert.equal(fourth.status, 0, `run 4 (fixed .env) should apply cleanly:\n${fourth.stdout}\n${fourth.stderr}`);
    assert.match(fourth.stdout, /applied/);
    assert.equal(applied(box), brokenSha, '.applied now names the commit that finally succeeded');

    // Run 5: fully quiescent. Nothing to fetch, and .applied already agrees
    // with HEAD -- back to the quiet, common case, with no docker call at all.
    const fifth = autoApply(box);
    assert.equal(fifth.status, 0);
    assert.equal(fifth.calls, '', 'a fully-applied box calls docker for nothing');
  });
});

describe('a box with no deploy/.applied at all', () => {
  it('treats it as needing an apply, not as already applied, and writes it once healthy', () => {
    const origin = freshOrigin();
    const box = cloneBox(origin.dir);
    writeEnv(box, ENV);

    assert.equal(applied(box), null, 'a fresh clone has never written .applied');

    const result = autoApply(box);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(applied(box), origin.sha, 'the first run writes .applied once the apply is verified healthy');
    assert.match(result.calls, /ps -q gateway/, 'it actually ran the apply, not a silent no-op');
  });
});

// ── The connector port a box-local overlay remaps (connector#1337) ─────────
describe('the connector port a box-local overlay remaps (connector#1337)', () => {
  it('asks compose for the published port, so it reads THIS connector and not a neighbour on the committed port', () => {
    const origin = freshOrigin();
    const box = cloneBox(origin.dir);
    writeEnv(box, ENV);

    const result = autoApply(box, { STUB_PORT: '127.0.0.1:4005' });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.calls, /port connector 4000/);
    assert.match(result.calls, /curl http:\/\/127\.0\.0\.1:4005\/ilp/, 'GET /ilp goes to the port compose reported');
    assert.doesNotMatch(result.calls, /curl http:\/\/127\.0\.0\.1:4000\/ilp/);
  });

  it('falls back to the committed file when compose has no answer', () => {
    const origin = freshOrigin();
    const box = cloneBox(origin.dir);
    writeEnv(box, ENV);

    const result = autoApply(box);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.calls, /curl http:\/\/127\.0\.0\.1:\d+\/ilp/);
  });
});

// ── COMPOSE_FILE (shared contract v2 point 3) ────────────────────────────────
// auto-apply.sh never re-parses COMPOSE_FILE's own value -- only whether
// .env sets it at all, read the same careful way TRACK_BRANCH is (a single
// well-formed line, never the whole .env). Set: no `-f` of its own, so
// docker compose reads COMPOSE_FILE itself and the shared-edge overlay
// (toon-protocol/gateway#18) actually takes effect. Unset: this script's own
// `-f docker-compose.yml` fallback -- today's default, named explicitly
// rather than left to docker compose's own file-discovery default.
// pull-images.sh makes its own `docker compose config`/`pull` calls, with no
// `-f` of its own either way (unaffected by this point -- it always let
// compose read COMPOSE_FILE from .env, or fall to compose's own default).
// Only auto-apply.sh's OWN calls -- up/ps/restart/logs/exec -- carry its
// `${COMPOSE[@]}`, so only those prove point 3.
const ownCall = (call) => /^compose (?:-f docker-compose\.yml )?(?:up -d|ps -q|restart |logs --tail 40 |exec -T nginx)/.test(call);

describe('COMPOSE_FILE (shared contract v2 point 3)', () => {
  it('with no COMPOSE_FILE in .env: auto-apply.sh names -f docker-compose.yml itself', () => {
    const origin = freshOrigin();
    const box = cloneBox(origin.dir);
    writeEnv(box, ENV); // .env.example ships COMPOSE_FILE commented out

    const result = autoApply(box);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const calls = result.calls.split('\n').filter(ownCall);
    assert.ok(calls.length > 0, 'expected at least one of auto-apply.sh\'s own compose calls');
    for (const call of calls) {
      assert.match(call, /^compose -f docker-compose\.yml /, `call did not name -f docker-compose.yml: ${call}`);
    }
  });

  it('with COMPOSE_FILE set in .env: auto-apply.sh never names its own -f', () => {
    const origin = freshOrigin();
    const box = cloneBox(origin.dir);
    // The overlay file need not exist for this: auto-apply.sh only checks
    // whether .env SETS the variable, never docker-compose.shared-edge.yml's
    // own presence or content. SHARED_EDGE=1 satisfies render.sh's own
    // (unrelated) cross-check so the render this run does still succeeds.
    writeEnv(box, {
      ...ENV,
      SHARED_EDGE: '1',
      COMPOSE_FILE: 'docker-compose.yml:docker-compose.shared-edge.yml',
    });

    const result = autoApply(box);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const calls = result.calls.split('\n').filter(ownCall);
    assert.ok(calls.length > 0, 'expected at least one of auto-apply.sh\'s own compose calls');
    for (const call of calls) {
      assert.doesNotMatch(call, /-f\s+docker-compose\.yml/, `call named its own -f despite COMPOSE_FILE in .env: ${call}`);
    }
  });
});
