// render.sh, run for real.
//
// bundle.test.mjs reads the templates; this renders them. Each case copies the
// committed bundle into a scratch git repository, commits it, writes a .env the
// way an operator would, runs the real render.sh and inspects what it wrote —
// so what is proved is what a fresh clone plus .env does, not what a fixture
// says it would.
//
// Two things are held still here, and why:
//   * the devnet preset renders BYTE FOR BYTE the connector.toml and nginx
//     config the devnet box ran before any of this was templated
//     (testdata/devnet.*, rendered by the render.sh of gateway f400f22). The
//     box's auto-apply restarts its connector on any change to a rendered
//     input, so a byte of drift here is a restart nobody asked for;
//   * an operator who is not us — their own ILP address, their own DNS
//     provider — renders a whole config from .env alone and leaves `git
//     status` clean, which is what lets auto-apply.sh keep fast-forwarding
//     their box.
//
// It needs bash and envsubst (gettext-base), as render.sh itself does.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (name) => readFileSync(join(HERE, name), 'utf8');
const envExample = read('.env.example');

// What the devnet gateway box's .env says beyond the preset. Secrets are
// placeholders: none of them reaches connector.toml or node.conf.
const DEVNET_BOX = {
  TOON_DEVNET_BOX: '1',
  ILP_ADDRESS: 'g.toon.workload-gateway',
  GATEWAY_DOMAIN: 'gw.devnet.toonprotocol.dev',
  EDGE_HOST: 'proxy.gateway.devnet.toonprotocol.dev',
  DNS_PROVIDER: 'porkbun',
  PORKBUN_ZONE: 'toonprotocol.dev',
  PORKBUN_API_KEY: 'pk1_placeholder',
  PORKBUN_SECRET_KEY: 'sk1_placeholder',
  OPERATOR_BEARER_TOKEN: 'placeholder-bearer',
  OPERATOR_WRITE_KEY: 'placeholder-write-key',
};

// Somebody else entirely: not under g.toon., and not on Porkbun.
const OUTSIDE_OPERATOR = {
  ILP_ADDRESS: 'g.acme.workload-gateway',
  GATEWAY_DOMAIN: 'gw.acme.example',
  EDGE_HOST: 'proxy.gateway.acme.example',
  DNS_PROVIDER: 'cloudflare',
  CLOUDFLARE_ZONE: 'acme.example',
  CLOUDFLARE_API_TOKEN: 'cf-token-placeholder',
  OPERATOR_BEARER_TOKEN: 'placeholder-bearer',
  OPERATOR_WRITE_KEY: 'placeholder-write-key',
};

const scratch = [];
after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

const run = (cmd, args, cwd) => spawnSync(cmd, args, { cwd, encoding: 'utf8' });

/** A fresh clone of the committed bundle: its own git repository, committed. */
function freshCheckout() {
  const dir = mkdtempSync(join(tmpdir(), 'gateway-render-'));
  scratch.push(dir);
  // Everything render.sh reads, plus the .gitignore that decides whether its
  // outputs dirty the tree.
  for (const name of ['render.sh', 'connector.toml.template', '.env.example', '.gitignore', 'nginx', 'certbot']) {
    cpSync(join(HERE, name), join(dir, name), { recursive: true });
  }
  rmSync(join(dir, 'nginx', 'conf.d'), { recursive: true, force: true });
  for (const args of [
    ['init', '--quiet'],
    ['add', '--all'],
    ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '--no-gpg-sign', '-m', 'bundle'],
  ]) {
    const git = run('git', args, dir);
    assert.equal(git.status, 0, git.stderr);
  }
  return dir;
}

/** .env as an operator writes it: .env.example, with their lines set. */
function writeEnv(dir, values) {
  let env = envExample;
  for (const [name, value] of Object.entries(values)) {
    const line = new RegExp(`^#? ?${name}=.*$`, 'm');
    env = line.test(env) ? env.replace(line, `${name}=${value}`) : `${env}\n${name}=${value}\n`;
  }
  writeFileSync(join(dir, '.env'), env);
}

function render(values) {
  const dir = freshCheckout();
  writeEnv(dir, values);
  const result = run('bash', ['render.sh'], dir);
  return { dir, ...result, file: (name) => readFileSync(join(dir, name), 'utf8') };
}

describe('render.sh needs', () => {
  it('bash and envsubst, as on a box', () => {
    assert.equal(run('bash', ['-c', 'command -v envsubst']).status, 0, 'envsubst is missing (apt-get install gettext-base)');
  });
});

describe('the devnet preset', () => {
  const box = render(DEVNET_BOX);

  it('renders', () => {
    assert.equal(box.status, 0, box.stderr);
  });

  it('renders connector.toml byte for byte as the devnet box ran it before', () => {
    assert.equal(box.file('connector.toml'), read('testdata/devnet.connector.toml'));
  });

  it('renders the nginx config byte for byte as the devnet box ran it before', () => {
    assert.equal(box.file('nginx/conf.d/node.conf'), read('testdata/devnet.node.conf'));
  });

  it('hands the Porkbun hook exactly its own three lines', () => {
    assert.equal(
      box.file('dns-01.env'),
      [
        "# The DNS-01 hook's environment. Rendered from .env by ./render.sh; do not edit.",
        'DNS_PROVIDER=porkbun',
        "PORKBUN_API_KEY='pk1_placeholder'",
        "PORKBUN_SECRET_KEY='sk1_placeholder'",
        "PORKBUN_ZONE='toonprotocol.dev'",
        '',
      ].join('\n'),
    );
  });
});

describe('an operator who is not us', () => {
  const op = render(OUTSIDE_OPERATOR);

  it('renders from .env alone', () => {
    assert.equal(op.status, 0, op.stderr);
  });

  it('hangs the handover route and [node] off their own ILP address', () => {
    const toml = op.file('connector.toml');
    assert.match(toml, /^prefix\s*=\s*"g\.acme\.workload-gateway\.handover"$/m);
    assert.match(toml, /^addresses\s*=\s*\["g\.acme\.workload-gateway"\]$/m);
    assert.match(toml, /^http_endpoint\s*=\s*"https:\/\/proxy\.gateway\.acme\.example\/ilp"$/m);
    assert.doesNotMatch(toml, /g\.toon/);
  });

  it('leaves no variable unrendered and no template note behind', () => {
    for (const name of ['connector.toml', 'nginx/conf.d/node.conf']) {
      const text = op.file(name);
      assert.doesNotMatch(text, /\$\{[A-Z_]+\}/, `${name} has an unrendered variable`);
      assert.doesNotMatch(text, /^#:/m, `${name} kept a template note`);
    }
  });

  it('hands certbot the Cloudflare lines and nothing else from .env', () => {
    const dns = op.file('dns-01.env');
    assert.match(dns, /^DNS_PROVIDER=cloudflare$/m);
    assert.match(dns, /^CLOUDFLARE_API_TOKEN='cf-token-placeholder'$/m);
    assert.match(dns, /^CLOUDFLARE_ZONE='acme\.example'$/m);
    // The bearer token gates the operator surface; the DNS hook has no use
    // for it, and neither does anything else in the certbot container.
    assert.doesNotMatch(dns, /OPERATOR|PORKBUN|SETTLEMENT/);
  });

  it('leaves `git status` clean, so auto-apply keeps fast-forwarding the box', () => {
    const status = run('git', ['status', '--porcelain', '--untracked-files=all'], op.dir);
    assert.equal(status.status, 0, status.stderr);
    assert.equal(status.stdout, '');
  });
});

describe('what render.sh refuses', () => {
  const refused = (overrides, pattern) => {
    const result = render({ ...OUTSIDE_OPERATOR, ...overrides });
    assert.notEqual(result.status, 0, 'render.sh accepted it');
    assert.match(result.stderr, pattern);
  };

  it('a g.toon. address without the devnet flag', () => {
    refused({ ILP_ADDRESS: 'g.toon.workload-gateway' }, /under g\.toon\., the TOON fleet's own namespace/);
  });

  it('no ILP address at all', () => {
    refused({ ILP_ADDRESS: '' }, /set ILP_ADDRESS in \.env/);
  });

  it('something that is not an ILP address', () => {
    refused({ ILP_ADDRESS: 'acme.workload-gateway' }, /is not an ILP address/);
  });

  it('a settlement value that is not the shape it lands in', () => {
    refused({ SETTLEMENT_EVM_TOKEN: '0x1234' }, /SETTLEMENT_EVM_TOKEN=0x1234 in \.env is not a 0x-prefixed 20-byte EVM address/);
  });

  it('a DNS provider with no hook', () => {
    refused({ DNS_PROVIDER: 'route53' }, /certbot\/route53\.py does not exist/);
  });

  it('a DNS provider whose credentials are not in .env', () => {
    refused({ DNS_PROVIDER: 'porkbun' }, /sets no PORKBUN_\* variable/);
  });
});
