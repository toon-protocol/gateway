// pull-images.sh, run for real against a stub `docker` on PATH.
//
// The script is the one thing between a pin in docker-compose.yml and a
// container on the box, so what it must do is held still here by running it,
// not by reading it:
//   * a real pin is PULLED, and a pull that fails fails the script — a bad pin
//     must stop an apply, never leave a stale container up;
//   * the `sha-0000000` placeholder on the gateway, and only there, is BUILT
//     from this checkout's Dockerfile and tagged with the pinned name, so the
//     devnet box keeps applying `main` before the first image is published;
//   * bootstrap.sh and auto-apply.sh get their images through it and nowhere
//     else, with no `--ignore-*` flag papering over a failed pull.
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'pull-images.sh');
const read = (name) => readFileSync(join(HERE, name), 'utf8');

const PLACEHOLDER_PIN = 'ghcr.io/toon-protocol/gateway:sha-0000000';
const REAL_PIN = 'ghcr.io/toon-protocol/gateway:sha-f278cd6';
const CONNECTOR_PIN = 'ghcr.io/toon-protocol/connector:rust-2026.09.11.1';

// A `docker` that answers the three things pull-images.sh asks of it and
// records every call, one per line, as its argv joined by spaces.
const STUB = `#!/usr/bin/env bash
echo "$*" >> "$STUB_LOG"
if [ "$1 $2 $3" = "compose config --services" ]; then
  printf '%s\\n' $STUB_SERVICES; exit 0
fi
if [ "$1 $2 $3" = "compose config --images" ]; then
  var="STUB_IMAGE_$4"; var=\${var//-/_}; echo "\${!var}"; exit 0
fi
if [ "$1 $2" = "compose pull" ]; then exit "\${STUB_PULL_EXIT:-0}"; fi
if [ "$1" = "build" ]; then exit 0; fi
echo "stub docker: unexpected call: $*" >&2; exit 97
`;

const work = mkdtempSync(join(tmpdir(), 'gateway-pull-images-'));
after(() => rmSync(work, { recursive: true, force: true }));
writeFileSync(join(work, 'docker'), STUB);
chmodSync(join(work, 'docker'), 0o755);

let runs = 0;
function pullImages({ images, pullExit = 0, args = [] }) {
  const log = join(work, `log-${runs++}`);
  writeFileSync(log, '');
  const env = {
    ...process.env,
    PATH: `${work}:${process.env.PATH}`,
    STUB_LOG: log,
    STUB_SERVICES: Object.keys(images).join(' '),
    STUB_PULL_EXIT: String(pullExit),
  };
  for (const [service, image] of Object.entries(images)) {
    env[`STUB_IMAGE_${service.replace(/-/g, '_')}`] = image;
  }
  const r = spawnSync('bash', [SCRIPT, ...args], { env, encoding: 'utf8' });
  const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean);
  return { status: r.status, stderr: r.stderr, calls };
}

const builds = (calls) => calls.filter((c) => c.startsWith('build '));
const pulls = (calls) => calls.filter((c) => c.startsWith('compose pull'));

describe('pull-images.sh', () => {
  it('builds the placeholder gateway pin from the checkout, tagged with the pinned name', () => {
    const r = pullImages({
      images: { gateway: PLACEHOLDER_PIN, connector: CONNECTOR_PIN, nginx: 'nginx:alpine' },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(builds(r.calls), [`build --quiet -t ${PLACEHOLDER_PIN} -f ../Dockerfile ..`]);
    // Everything else is still pulled, and the gateway is not asked of GHCR.
    assert.deepEqual(pulls(r.calls), ['compose pull --quiet connector nginx']);
    assert.match(r.stderr, /placeholder pin/);
  });

  it('pulls a real gateway pin, and builds nothing', () => {
    const r = pullImages({ images: { gateway: REAL_PIN, connector: CONNECTOR_PIN } });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(builds(r.calls), []);
    assert.deepEqual(pulls(r.calls), ['compose pull --quiet gateway connector']);
  });

  it('fails loudly when a real pin will not pull', () => {
    const r = pullImages({ images: { gateway: REAL_PIN, connector: CONNECTOR_PIN }, pullExit: 1 });
    assert.notEqual(r.status, 0, 'a failed pull must fail the script, and with it the apply');
  });

  it('builds only images this repository builds, even on the placeholder tag', () => {
    const r = pullImages({
      images: { gateway: REAL_PIN, connector: 'ghcr.io/toon-protocol/connector:sha-0000000' },
      pullExit: 1,
    });
    assert.deepEqual(builds(r.calls), []);
    assert.notEqual(r.status, 0, 'a placeholder on an image not built here is just a pin that will not pull');
  });

  it('takes only the services it is named', () => {
    const r = pullImages({
      images: { gateway: PLACEHOLDER_PIN, connector: CONNECTOR_PIN },
      args: ['connector'],
    });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(builds(r.calls), []);
    assert.deepEqual(pulls(r.calls), ['compose pull --quiet connector']);
  });
});

describe('who gets images through it', () => {
  for (const name of ['bootstrap.sh', 'auto-apply.sh']) {
    it(`${name} calls pull-images.sh, and neither pulls nor builds on its own`, () => {
      const code = read(name)
        .split('\n')
        .filter((line) => !/^\s*#/.test(line))
        .join('\n');
      assert.match(code, /^\s*\.\/pull-images\.sh\s*$/m);
      assert.doesNotMatch(code, /docker compose\b[^\n]*\s(pull|build)\b/);
      assert.doesNotMatch(code, /--ignore-(pull-failures|buildable)/);
    });
  }

  it('is executable', () => {
    const mode = spawnSync('stat', ['-c', '%a', SCRIPT], { encoding: 'utf8' }).stdout.trim();
    assert.match(mode, /^7[0-7][0-7]$/);
  });
});
