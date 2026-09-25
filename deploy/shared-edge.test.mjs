// docker-compose.shared-edge.yml, merged by the REAL `docker compose`
// (toon-protocol/gateway#18).
//
// bundle.test.mjs holds the overlay's own source text still; this instead
// asks the tool that actually reads it — `docker compose config` — what the
// two files merge into, so a YAML mistake that regex-matches fine (wrong
// nesting, a key regex can't see is shadowed, `external: true` typo'd) fails
// here instead of shipping. This is this repository's automated stand-in for
// the issue's "run with the overlay against a local edge network... binds no
// host port 80 or 443" — short of pulling the real gateway/connector images
// and funding real settlement keys just to prove a compose file merges
// correctly, which `docker compose config` needs neither of, and which every
// other script test in this suite avoids for the same reason (stub the
// world, never require a live pull or a live daemon's state). The container
// build/pull, boot and curl-through-a-stub-edge proof is a manual step for
// whoever cuts this box over (deploy/README.md § "Running behind the shared
// edge").
//
// Skips itself, loudly, on a machine with no `docker compose` — the one
// external dependency this file adds to the suite.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (name) => readFileSync(join(HERE, name), 'utf8');
const envExample = read('.env.example');

const dockerCompose = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' });
const skip = dockerCompose.status === 0 ? false : 'docker compose is not available on this machine';

const REQUIRED = {
  ILP_ADDRESS: 'g.fixture.workload-gateway',
  GATEWAY_DOMAIN: 'gw.fixture.example',
  EDGE_HOST: 'proxy.gateway.fixture.example',
  OPERATOR_BEARER_TOKEN: 'fixture-bearer',
  OPERATOR_WRITE_KEY: '0'.repeat(64),
};

const scratch = [];
after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** A scratch directory holding just the two compose files and a .env — no
 * render.sh run, no keys: `docker compose config` reads neither. */
function bundle(overrides) {
  const dir = mkdtempSync(join(tmpdir(), 'gateway-shared-edge-'));
  scratch.push(dir);
  writeFileSync(join(dir, 'docker-compose.yml'), read('docker-compose.yml'));
  writeFileSync(join(dir, 'docker-compose.shared-edge.yml'), read('docker-compose.shared-edge.yml'));
  // certbot's `env_file: dns-01.env` must exist for `config` to resolve it,
  // whether or not the overlay disables certbot — an empty file is enough.
  writeFileSync(join(dir, 'dns-01.env'), '');
  let env = envExample;
  for (const [name, value] of Object.entries({ ...REQUIRED, ...overrides })) {
    const line = new RegExp(`^#? ?${name}=.*$`, 'm');
    env = line.test(env) ? env.replace(line, `${name}=${value}`) : `${env}\n${name}=${value}\n`;
  }
  writeFileSync(join(dir, '.env'), env);
  return dir;
}

function config(dir, args = []) {
  const r = spawnSync('docker', ['compose', 'config', ...args], { cwd: dir, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe('the shared-edge overlay, merged by docker compose itself', { skip }, () => {
  it('with the overlay named: only gateway and connector run — no nginx, no certbot, no host port 80 or 443', () => {
    const dir = bundle({
      SHARED_EDGE: '1',
      COMPOSE_FILE: 'docker-compose.yml:docker-compose.shared-edge.yml',
    });
    const services = config(dir, ['--services']);
    assert.equal(services.status, 0, services.stderr);
    assert.deepEqual(services.stdout.trim().split('\n').sort(), ['connector', 'gateway']);

    const full = config(dir);
    assert.equal(full.status, 0, full.stderr);
    assert.doesNotMatch(full.stdout, /published: "80"|published: "443"/, 'a host port 80 or 443 is bound with the overlay on');
    assert.match(full.stdout, /aliases:\s*\n\s*- gateway-gw/, 'gateway is not aliased gateway-gw on `edge`');
    assert.match(full.stdout, /aliases:\s*\n\s*- gateway-proxy/, 'connector is not aliased gateway-proxy on `edge`');
    assert.match(full.stdout, /edge:\s*\n\s*name: edge\s*\n\s*external: true/, '`edge` is not declared external');
    // mem_limit survives the merge as a number of bytes; a per-service
    // presence check, not a value (README documents the values are provisional).
    // Split at each line indented by EXACTLY two spaces (a top-level key) so
    // a service's own deeper-indented content doesn't cut the block short.
    const blocks = full.stdout.split(/\n(?=  \S)/);
    for (const service of ['gateway', 'connector']) {
      const block = blocks.find((b) => b.startsWith(`  ${service}:`));
      assert.ok(block, `no ${service}: block in the merged config`);
      assert.match(block, /mem_limit: "\d+"/, `${service} has no mem_limit once merged`);
    }
    // The connector's own loopback publish survives the overlay untouched.
    assert.match(full.stdout, /host_ip: 127\.0\.0\.1\s*\n\s*target: 4000/);
  });

  it('with no COMPOSE_FILE line: the default is exactly what it always was — nginx and certbot run, 80 and 443 are bound', () => {
    const dir = bundle({});
    const services = config(dir, ['--services']);
    assert.equal(services.status, 0, services.stderr);
    assert.deepEqual(services.stdout.trim().split('\n').sort(), ['certbot', 'connector', 'gateway', 'nginx']);

    const full = config(dir);
    assert.equal(full.status, 0, full.stderr);
    assert.match(full.stdout, /published: "80"/);
    assert.match(full.stdout, /published: "443"/);
    assert.doesNotMatch(full.stdout, /mem_limit/, 'the default must carry no mem_limit — the overlay was not named');
    assert.doesNotMatch(full.stdout, /\bedge:\s*\n\s*name: edge/, 'the default must not reference the `edge` network — the overlay was not named');
  });
});
