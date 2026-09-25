// The guard on the deploy bundle.
//
// It reads the REAL files, not fixtures: a fixture would keep passing while
// the shipped artifact regressed. Every expected value is a literal declared
// here and never read back out of the file under test, so a reverted fix fails
// this suite instead of quietly agreeing with itself.
//
// It has no dependencies. This repository ships a parser for neither TOML nor
// YAML and does not need one for this: the assertions below are about exact
// lines a human wrote, and a regex over the real bytes catches the same
// regressions a parse would while keeping the dependency tree at zero.
//
// What it holds still, and why:
//   * the one terminated route, its handler and its price — the handler path
//     is where a handover lands, and nothing else decides it;
//   * the settlement deployment, because a node that settles against the
//     wrong token cannot be paid and says so only at boot;
//   * `[node]`, because a node that cannot say where it is cannot be reached;
//   * the connector pin and the gateway pin, each in exactly one place,
//     because two copies drift;
//   * the exposure invariants: the door is never published, the connector's
//     edge is loopback-only, and only the TLS front faces the internet;
//   * `GATEWAY_DIAL_REWRITE`, which is the sandbox's one line that would be
//     wrong here;
//   * healthchecks dialling 127.0.0.1, because "localhost" in a container can
//     resolve to ::1, where an IPv4-bound listener never answers;
//   * the shared-edge overlay (toon-protocol/gateway#18): nginx and certbot
//     disabled, `gateway`/`connector` joined to this node's own external
//     `edge-gateway` network — never the old flat `edge` shared contract v2
//     retired — under their stable aliases, a mem_limit on every service, and
//     the default (no overlay named) left byte-for-byte unchanged;
//   * auto-apply.sh never re-parsing COMPOSE_FILE's own value, only whether
//     `.env` sets it at all — set, no `-f` of its own; unset, its own
//     `-f docker-compose.yml` fallback — so `COMPOSE_FILE` in `.env`, not a
//     guess, picks the overlay;
//   * SHARED_EDGE named everywhere cert work has to stop for it (render.sh,
//     bootstrap.sh, auto-apply.sh's nginx reload) — shape-checked here, run
//     for real in render.test.mjs and init-letsencrypt.test.mjs.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (name) => readFileSync(join(HERE, name), 'utf8');

const compose = read('docker-compose.yml');
const connectorToml = read('connector.toml.template');
const nginxConf = read('nginx/node.conf.template');
const envExample = read('.env.example');
const gitignore = read('.gitignore');
const renderSh = read('render.sh');
const sharedEdge = read('docker-compose.shared-edge.yml');
const autoApplySh = read('auto-apply.sh');
const bootstrapSh = read('bootstrap.sh');
const initLetsencryptSh = read('init-letsencrypt.sh');
const readme = read('README.md');

// ── The literals this bundle is ───────────────────────────────────────────
// The route and the address are templated off ILP_ADDRESS, so what is held
// still here is the template's spelling of them; render.test.mjs renders the
// devnet preset and holds the result to what the devnet box ran before.
const ILP_ADDRESS = '${ILP_ADDRESS}';
const HANDOVER_ROUTE = '${ILP_ADDRESS}.handover';
const HANDOVER_PORT = '8081';
const HANDOVER_HANDLER = 'http://gateway:8081/handover';
const CONNECTOR_PIN = 'ghcr.io/toon-protocol/connector:rust-2026.09.11.1';
// An immutable build: a dated release alias or an exact commit. Never
// `rust-main`, and never the retired `rust-release` pointer.
const IMMUTABLE_PIN = /:(rust-sha-[0-9a-f]{7,40}|rust-\d{4}\.\d{2}\.\d{2}\.\d+)$/;

// ── The gateway pin (TOON_Network#155) ──────────────────────────────────────
//
// The pin is the workflow's first publish, from the merge of #12, and its
// literal is held here beside the compose file's the way CONNECTOR_PIN is:
// the pin moves by a reviewed commit that changes both. The tests below also
// hold its SHAPE (an immutable tag, never a floating alias, never a `build:`)
// and that it is written in exactly one place.
const GATEWAY_PIN = 'ghcr.io/toon-protocol/gateway:sha-b469549';
// This repository's own scheme has no `rust-` prefix (it isn't Rust): a
// `sha-<short-sha>` build, or a bare dated/semver-shaped release alias such as
// `2026.09.11.1` or `1.2.3`. `latest`, `main` and anything empty are
// floating, not pins.
const IMMUTABLE_GATEWAY_PIN = /:(sha-[0-9a-f]{7,40}|\d+(?:\.\d+)+)$/;

/**
 * A literal, escaped for use inside a RegExp.
 *
 * The whole metacharacter class, including the backslash. Escaping only `/`
 * and `.` — the characters these particular constants happen to contain —
 * leaves a `\` in a future constant to escape whatever follows it, which is
 * the `js/incomplete-sanitization` shape. Nothing here is attacker-controlled,
 * but a half-escape is cheaper to not write than to explain.
 */
const rx = (literal) => literal.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');

describe('the terminated route', () => {
  it('is the one sealed handover route, free, at the door the gateway serves', () => {
    assert.match(connectorToml, new RegExp(`prefix\\s*=\\s*"${rx(HANDOVER_ROUTE)}"`));
    assert.match(connectorToml, new RegExp(`handler_url\\s*=\\s*"${rx(HANDOVER_HANDLER)}"`));
    // `price = 0` is WRITTEN, never omitted: a terminated route is never
    // silently free, and the parser requires a price either way.
    assert.match(connectorToml, /price\s*=\s*0\b/);
  });

  it('terminates nothing else', () => {
    const prefixes = [...connectorToml.matchAll(/^\s*prefix\s*=\s*"([^"]+)"/gm)].map((m) => m[1]);
    assert.deepEqual(prefixes, [HANDOVER_ROUTE]);
  });

  it('forwards to the port the gateway is told to open the door on', () => {
    assert.match(compose, new RegExp(`GATEWAY_HANDOVER_PORT:\\s*'${HANDOVER_PORT}'`));
  });
});

describe('[node] — what this box says it is', () => {
  it('claims exactly its own address', () => {
    assert.match(connectorToml, new RegExp(`addresses\\s*=\\s*\\["${rx(ILP_ADDRESS)}"\\]`));
  });

  it('advertises public, TLS endpoints, rendered from one variable', () => {
    assert.match(connectorToml, /http_endpoint\s*=\s*"https:\/\/\$\{EDGE_HOST\}\/ilp"/);
    assert.match(connectorToml, /btp_endpoint\s*=\s*"wss:\/\/\$\{EDGE_HOST\}\/ilp\/btp"/);
  });
});

describe('settlement', () => {
  it('takes every chain, contract, token and RPC from .env', () => {
    for (const [key, name] of [
      ['rpc_url', 'SETTLEMENT_EVM_RPC_URL'],
      ['contract_address', 'SETTLEMENT_EVM_REGISTRY'],
      ['token_address', 'SETTLEMENT_EVM_TOKEN'],
      ['rpc_url', 'SETTLEMENT_SOLANA_RPC_URL'],
      ['program_id', 'SETTLEMENT_SOLANA_PROGRAM_ID'],
      ['token_address', 'SETTLEMENT_SOLANA_TOKEN'],
    ]) {
      assert.match(connectorToml, new RegExp(`^${key}\\s*=\\s*"\\$\\{${name}\\}"`, 'm'));
    }
    assert.match(connectorToml, /^decimals\s*=\s*\$\{SETTLEMENT_EVM_DECIMALS\}$/m);
    assert.match(connectorToml, /^decimals\s*=\s*\$\{SETTLEMENT_SOLANA_DECIMALS\}$/m);
    // No literal chain value is left behind in the template to disagree with .env.
    assert.doesNotMatch(connectorToml.replace(/^#.*$/gm, ''), /0x[0-9a-fA-F]{40}|devnet|sepolia/i);
  });

  it('presets Base Sepolia through the registry, against the 6dp mock USDC', () => {
    assert.match(envExample, /^SETTLEMENT_EVM_RPC_URL=https:\/\/base-sepolia-rpc\.publicnode\.com$/m);
    assert.match(envExample, /^SETTLEMENT_EVM_REGISTRY=0x0c41D9D424d6B075A3cEa1068a694f7847a8CCa5$/m);
    assert.match(envExample, /^SETTLEMENT_EVM_TOKEN=0x49beE1Bca5d15Fb0963117923403F9498119a9Ce$/m);
  });

  it('presets Solana devnet against the deployed payment-channel program', () => {
    assert.match(envExample, /^SETTLEMENT_SOLANA_RPC_URL=https:\/\/api\.devnet\.solana\.com$/m);
    assert.match(envExample, /^SETTLEMENT_SOLANA_PROGRAM_ID=2aEVJ8koKD8LTZrLRSGtAtU7LBt4e7QjjCgf1kzQ7Rip$/m);
    assert.match(envExample, /^SETTLEMENT_SOLANA_TOKEN=34eSxY7qxQ4GzyhDJ8GpUcTz1WWzruGbJbR8q6TtxfQU$/m);
  });

  it('presets 6 decimals on both legs, which the connector checks against the chain', () => {
    assert.match(envExample, /^SETTLEMENT_EVM_DECIMALS=6$/m);
    assert.match(envExample, /^SETTLEMENT_SOLANA_DECIMALS=6$/m);
  });

  it('labels the devnet values as a preset, and keeps them inside it', () => {
    const start = envExample.indexOf('THE TOON DEVNET PRESET');
    const end = envExample.indexOf('End of the devnet preset.');
    assert.ok(start > 0 && end > start, '.env.example has no labelled devnet preset');
    const outside = (envExample.slice(0, start) + envExample.slice(end)).replace(/^#.*$/gm, '');
    assert.doesNotMatch(outside, /devnet|sepolia/i, 'a devnet value sits outside the preset');
  });

  it('names key FILES, never key values', () => {
    for (const file of ['signer.key', 'settlement.key', 'settlement-solana.key']) {
      assert.match(connectorToml, new RegExp(`key_file\\s*=\\s*"/app/data/${file}"`));
    }
    // Nothing that looks like raw key material may appear in a committed file.
    assert.doesNotMatch(connectorToml, /\b[0-9a-f]{64}\b/);
  });
});

describe('the operator surface', () => {
  it('is configured by file path only', () => {
    assert.match(connectorToml, /bearer_token_file\s*=\s*"\/app\/data\/operator-bearer\.token"/);
    assert.match(connectorToml, /write_keys_file\s*=\s*"\/app\/data\/operator-write\.keys"/);
    assert.doesNotMatch(connectorToml, /^\s*bearer_token\s*=/m);
    assert.doesNotMatch(connectorToml, /^\s*write_keys\s*=/m);
  });

  it('mounts both credential files read-only', () => {
    assert.match(compose, /\.\/operator-bearer\.token:\/app\/data\/operator-bearer\.token:ro/);
    assert.match(compose, /\.\/operator-write\.keys:\/app\/data\/operator-write\.keys:ro/);
  });

  it('calls the allowlist what it is: an ed25519 PUBLIC key, and not a nostr one', () => {
    assert.match(envExample, /ED25519 PUBLIC key/);
    assert.match(envExample, /NOT a nostr npub/);
  });
});

describe('state', () => {
  it('keeps the claim watermark on a named volume, never a bind', () => {
    assert.match(connectorToml, /state_dir\s*=\s*"\/app\/state"/);
    // A bind would start `./`; the image ships /app/state owned by uid 10001,
    // which a fresh named volume inherits on first mount and a bind does not.
    assert.match(compose, /^\s+- connector_state:\/app\/state$/m);
    assert.doesNotMatch(compose, /\.\/[^\s:]*:\/app\/state/);
    assert.match(compose, /^volumes:\n(?:.*\n)*?\s{2}connector_state:$/m);
  });

  it('needs no volume for the gateway itself, because every grant is in memory', () => {
    // The gateway's only mount is the read-only internal certificate pair. A
    // named volume here would imply state that survives a restart, and none
    // does — a restart drops every grant and each tenant re-seals.
    const gatewayBlock = compose.slice(compose.indexOf('  gateway:'), compose.indexOf('  connector:'));
    assert.match(gatewayBlock, /- \.\/tls:\/etc\/workload-gateway\/tls:ro/);
    assert.doesNotMatch(gatewayBlock, /^\s+- [a-z_]+:\//m);
  });
});

describe('the connector pin', () => {
  it('is an immutable build', () => {
    assert.match(CONNECTOR_PIN, IMMUTABLE_PIN);
    assert.match(compose, new RegExp(`image:\\s*${rx(CONNECTOR_PIN)}\\s*$`, 'm'));
  });

  it('is written in docker-compose.yml and nowhere else in the bundle', () => {
    const elsewhere = ['connector.toml.template', 'nginx/node.conf.template', 'auto-apply.sh', 'render.sh', 'bootstrap.sh', 'pull-images.sh'];
    for (const name of elsewhere) {
      assert.doesNotMatch(read(name), /rust-sha-|rust-main|rust-release|rust-\d{4}\.\d{2}\.\d{2}\.\d+/, `${name} names a connector build`);
    }
  });

  it('never follows a moving tag', () => {
    assert.doesNotMatch(compose, /connector:(rust-main|rust-release|latest)\b/);
  });

  it('mounts its config rather than baking it, and builds nothing', () => {
    assert.match(compose, /\.\/connector\.toml:\/app\/config\/connector\.toml:ro/);
    const connectorBlock = compose.slice(compose.indexOf('  connector:'), compose.indexOf('  nginx:'));
    assert.doesNotMatch(connectorBlock, /^\s+build:/m);
  });
});

describe('the gateway pin', () => {
  it('agrees with the connector pin about what counts as immutable', () => {
    // The predicate above must not be so loose it would wave a floating alias
    // through, nor so strict it would reject the placeholder this bundle
    // actually ships — that would mean the shape check and the real pin
    // disagree about what a pin is. Checked against full pin-shaped strings,
    // the same way IMMUTABLE_PIN above is checked against CONNECTOR_PIN.
    assert.match('ghcr.io/toon-protocol/gateway:sha-f278cd6', IMMUTABLE_GATEWAY_PIN);
    assert.match('ghcr.io/toon-protocol/gateway:2026.09.11.1', IMMUTABLE_GATEWAY_PIN);
    assert.match('ghcr.io/toon-protocol/gateway:1.2.3', IMMUTABLE_GATEWAY_PIN);
    assert.doesNotMatch('ghcr.io/toon-protocol/gateway:main', IMMUTABLE_GATEWAY_PIN);
    assert.doesNotMatch('ghcr.io/toon-protocol/gateway:latest', IMMUTABLE_GATEWAY_PIN);
    assert.doesNotMatch('ghcr.io/toon-protocol/gateway', IMMUTABLE_GATEWAY_PIN);
  });

  it('is an immutable build, in shape', () => {
    // The literal is GATEWAY_PIN's; this holds that it is an immutable tag
    // and that the compose file ships exactly it.
    assert.match(GATEWAY_PIN, IMMUTABLE_GATEWAY_PIN);
    assert.match(compose, new RegExp(`image:\\s*${rx(GATEWAY_PIN)}\\s*$`, 'm'));
  });

  it('appears exactly once in docker-compose.yml, and nowhere else in the bundle', () => {
    const pins = [...compose.matchAll(/^\s*image:\s*ghcr\.io\/toon-protocol\/gateway:\S+\s*$/gm)];
    assert.equal(pins.length, 1, `expected exactly one gateway image: line, found ${pins.length}`);

    const elsewhere = ['connector.toml.template', 'nginx/node.conf.template', 'auto-apply.sh', 'render.sh', 'bootstrap.sh', 'pull-images.sh'];
    for (const name of elsewhere) {
      assert.doesNotMatch(
        read(name),
        /ghcr\.io\/toon-protocol\/gateway:/,
        `${name} names a gateway build; the pin belongs in docker-compose.yml alone`,
      );
    }
  });

  it('never follows a moving tag', () => {
    assert.doesNotMatch(compose, /toon-protocol\/gateway:(main|latest|release)\b/);
  });

  it('replaces the build step entirely — no `build:` left for the gateway service', () => {
    const gatewayBlock = compose.slice(compose.indexOf('  gateway:'), compose.indexOf('  connector:'));
    assert.doesNotMatch(gatewayBlock, /^\s+build:/m, 'gateway was supposed to be pinned by image, not built');
    assert.match(gatewayBlock, /^\s*image:\s*ghcr\.io\/toon-protocol\/gateway:/m);
  });
});

describe('exposure', () => {
  it('never publishes the door', () => {
    // Reaching GATEWAY_HANDOVER_PORT directly would be a way to tell this
    // gateway what to serve without paying its connector a packet.
    const publishes = [...compose.matchAll(/^\s+- '([^']*\d+:\d+)'/gm)].map((m) => m[1]);
    for (const row of publishes) {
      assert.doesNotMatch(row, new RegExp(`:${HANDOVER_PORT}$`), `${row} publishes the handover door`);
    }
    assert.match(compose, /expose: \['8080', '8443', '8081'\]/);
  });

  it('publishes the connector edge on the loopback only', () => {
    assert.match(compose, /- '127\.0\.0\.1:4000:4000'/);
  });

  it('gives an unqualified publish to the TLS front and to nothing else', () => {
    // Docker's iptables chain runs ahead of ufw, so an unqualified publish is
    // internet-reachable even with ufw locked to 22/80/443.
    const publishes = [...compose.matchAll(/^\s+- '([^']*\d+:\d+)'/gm)].map((m) => m[1]);
    const unqualified = publishes.filter((row) => !row.startsWith('127.0.0.1:'));
    assert.deepEqual(unqualified.sort(), ['443:443', '80:80']);
  });

  it('carries no sandbox dial rewrite', () => {
    for (const name of ['docker-compose.yml', '.env.example']) {
      assert.doesNotMatch(read(name).replace(/^#.*$/gm, ''), /GATEWAY_DIAL_REWRITE\s*[:=]/m);
    }
  });
});

describe('healthchecks', () => {
  it('dial 127.0.0.1, never localhost', () => {
    const tests = [...compose.matchAll(/https?:\/\/(localhost|127\.0\.0\.1)[:/]/g)].map((m) => m[1]);
    assert.ok(tests.length > 0);
    assert.ok(!tests.includes('localhost'));
  });

  it('prove the gateway answered, not merely that it is up', () => {
    // An ungranted hostname is answered with the gateway's own 503 and dials
    // nothing: a liveness probe that touches no provider.
    assert.match(compose, /toon-gateway-reason.*no_grant/);
  });

  it('prove the connector read its signer key', () => {
    assert.match(compose, /\/ilp\/identity/);
  });
});

describe('the TLS edge', () => {
  it('serves the wildcard and the edge host from one certificate lineage', () => {
    assert.match(nginxConf, /server_name \$\{GATEWAY_DOMAIN\} \*\.\$\{GATEWAY_DOMAIN\};/);
    assert.match(nginxConf, /server_name \$\{EDGE_HOST\};/);
    assert.equal([...nginxConf.matchAll(/ssl_certificate\s+\/etc\/letsencrypt\/live\/\$\{CERT_NAME\}/g)].length, 2);
  });

  it('reaches the gateway over TLS, so a workload is told the scheme the visitor used', () => {
    assert.match(nginxConf, /proxy_pass https:\/\/\$upstream:8443;/);
    assert.match(nginxConf, /proxy_set_header X-Forwarded-Proto https;/);
  });

  it('re-resolves its upstreams, so a recreated container does not 502 until someone reloads', () => {
    assert.equal([...nginxConf.matchAll(/resolver 127\.0\.0\.11 valid=10s ipv6=off;/g)].length, 2);
  });

  it('leaves the Host header alone, because the gateway keys everything off it', () => {
    assert.match(nginxConf, /proxy_set_header Host \$host;/);
  });
});

describe('render.sh', () => {
  it('refuses an ILP edge under the gateway domain', () => {
    // A name there is a name a tenant can never be handed.
    assert.match(renderSh, /must not be under GATEWAY_DOMAIN/);
  });

  it('renders every file the bundle needs and nothing the bundle commits', () => {
    for (const output of ['connector.toml', 'operator-bearer.token', 'operator-write.keys', 'nginx/conf.d/node.conf', 'dns-01.env']) {
      assert.ok(renderSh.includes(output), `render.sh does not write ${output}`);
    }
  });
});

describe('nothing secret is committable', () => {
  it('gitignores every rendered output and every key', () => {
    for (const line of ['.env', 'connector.toml', 'operator-bearer.token', 'operator-write.keys', 'dns-01.env', 'nginx/conf.d/', 'tls/', '*.key']) {
      assert.ok(
        gitignore.split('\n').some((row) => row.trim() === line),
        `.gitignore does not carry ${line}`,
      );
    }
    assert.ok(gitignore.split('\n').some((row) => row.trim() === '!.env.example'));
  });

  it('ships an .env.example with every required variable empty', () => {
    // Who this gateway is and how it proves its zone are the operator's to
    // say; a devnet default for any of them would be a copy of our box.
    for (const name of ['ILP_ADDRESS', 'GATEWAY_DOMAIN', 'EDGE_HOST', 'DNS_PROVIDER', 'OPERATOR_BEARER_TOKEN', 'OPERATOR_WRITE_KEY']) {
      assert.match(envExample, new RegExp(`^${name}=$`, 'm'), `${name} is not present-and-empty in .env.example`);
    }
  });

  it('hands certbot the DNS hook\'s own variables, never the whole .env', () => {
    const certbotBlock = compose.slice(compose.indexOf('  certbot:'), compose.indexOf('\nvolumes:'));
    assert.match(certbotBlock, /^\s+env_file: dns-01\.env$/m);
    assert.doesNotMatch(certbotBlock, /env_file:\s*\.\/?\.env\b|PORKBUN|CLOUDFLARE/);
  });
});

// ── The shared-edge overlay (toon-protocol/gateway#18, infra#24, infra#25) ──
// docker-compose.yml is the DEFAULT; this overlay is only ever additive, and
// only when a .env names it in COMPOSE_FILE. Every assertion below is about
// the overlay file alone, or about docker-compose.yml staying exactly what it
// was, so a regression in either direction fails here.
describe('the shared-edge overlay', () => {
  it('is named exactly the way the provider bundle names its own overlay', () => {
    // COMPOSE_FILE=docker-compose.yml:docker-compose.shared-edge.yml — the same
    // colon-joined pattern `git -C provider show origin/main:deploy/docker-compose.hidden.yml`
    // uses, so docker compose (which reads COMPOSE_FILE out of .env itself)
    // needs no `-f` from any script in this bundle.
    assert.match(sharedEdge, /COMPOSE_FILE=docker-compose\.yml:docker-compose\.shared-edge\.yml/);
  });

  it('disables nginx and certbot, so neither runs and neither binds a host port', () => {
    const blocks = sharedEdge.split(/\n(?=  \S)/);
    for (const name of ['nginx', 'certbot']) {
      const block = blocks.find((b) => b.startsWith(`  ${name}:`));
      assert.ok(block, `no ${name}: service in the overlay`);
      assert.match(block, /profiles:\s*\[disabled\]/, `${name} is not disabled`);
    }
  });

  it('joins the gateway to `edge-gateway` under gateway-gw, the alias the shared edge dials for gw.devnet and *.gw.devnet', () => {
    const gatewayBlock = sharedEdge.slice(sharedEdge.indexOf('\n  gateway:'), sharedEdge.indexOf('\n  connector:'));
    assert.match(gatewayBlock, /networks:\s*\n\s+default:\s*\{\}\s*\n\s+edge-gateway:\s*\n\s+aliases:\s*\[gateway-gw\]/);
  });

  it('joins the connector to `edge-gateway` under gateway-proxy, the alias the shared edge dials for proxy.gateway.devnet', () => {
    const connectorBlock = sharedEdge.slice(sharedEdge.indexOf('\n  connector:'), sharedEdge.indexOf('\n  nginx:'));
    assert.match(connectorBlock, /networks:\s*\n\s+default:\s*\{\}\s*\n\s+edge-gateway:\s*\n\s+aliases:\s*\[gateway-proxy\]/);
  });

  it('declares `edge-gateway` as the external network the host edge owns, not one this bundle creates, and never joins the old flat `edge`', () => {
    assert.match(sharedEdge, /^networks:\n\s+edge-gateway:\n\s+external:\s*true\s*$/m);
    // Shared contract v2: no node's containers sit on a network another
    // node's containers are also on. A stray literal `edge:` (rather than
    // `edge-gateway:`) network key would be exactly that regression.
    assert.doesNotMatch(sharedEdge, /^\s+edge:\s*$/m);
  });

  it('gives every service a mem_limit', () => {
    // Split the file into blocks at each line indented by EXACTLY two spaces
    // (`  name:`) — a line indented further is that service's own content, so
    // this cuts the file into one chunk per top-level key (`networks:`,
    // `gateway:`, `connector:`, `nginx:`, `certbot:`).
    const blocks = sharedEdge.split(/\n(?=  \S)/);
    for (const name of ['gateway', 'connector', 'nginx', 'certbot']) {
      const block = blocks.find((b) => b.startsWith(`  ${name}:`));
      assert.ok(block, `no ${name}: service in the overlay`);
      assert.match(block, /mem_limit:\s*\d+[mg]/i, `${name} has no mem_limit`);
    }
  });

  it('gateway and connector carry a measured mem_limit comment, not the old provisional one', () => {
    // These two are the only services this overlay actually runs, so they're
    // the only ones anyone has measured `docker stats` against — the
    // comment should say so and point back at the issue, without this test
    // hardcoding the exact MB figures (those belong to the file, not to a
    // second copy here that would drift from it).
    const blocks = sharedEdge.split(/\n(?=  \S)/);
    for (const name of ['gateway', 'connector']) {
      const block = blocks.find((b) => b.startsWith(`  ${name}:`));
      assert.ok(block, `no ${name}: service in the overlay`);
      assert.match(block, /#.*measured idle \d+ ?MB on 2026-09-25.*toon-protocol\/infra#25 step 2/, `${name}'s mem_limit comment doesn't cite a measurement and infra#25`);
      assert.doesNotMatch(block, /provisional/i, `${name}'s mem_limit comment still says provisional`);
    }
  });

  it('nginx and certbot keep their old provisional mem_limit comment — disabled, never measured', () => {
    // Nobody re-measures a proxy that never runs under this overlay; their
    // small limits are just carried over from before.
    const blocks = sharedEdge.split(/\n(?=  \S)/);
    for (const name of ['nginx', 'certbot']) {
      const block = blocks.find((b) => b.startsWith(`  ${name}:`));
      assert.ok(block, `no ${name}: service in the overlay`);
      assert.match(block, /provisional — replace with docker stats measurements \(toon-protocol\/infra#25 step 2\)/, `${name}'s mem_limit is no longer marked provisional`);
    }
  });

  it('never gives docker-compose.yml a mem_limit, a profile or a networks: section of its own — the default is unchanged', () => {
    assert.doesNotMatch(compose, /^\s*mem_limit:/m);
    assert.doesNotMatch(compose, /^\s*profiles:/m);
    assert.doesNotMatch(compose, /^networks:/m);
  });

  it('never edits docker-compose.yml\'s own port publishes — the default still binds 80 and 443 with no overlay named', () => {
    assert.match(compose, /- '80:80'/);
    assert.match(compose, /- '443:443'/);
  });
});

describe('scripts respect COMPOSE_FILE (the shared-edge overlay is a .env line, not a script flag, shared contract v2 point 3)', () => {
  it('auto-apply.sh never re-parses COMPOSE_FILE\'s own value, only whether .env sets it', () => {
    // The bug this guards: an unconditional, hardcoded `-f docker-compose.yml`
    // on every `docker compose` call would outrank COMPOSE_FILE from .env
    // (compose flags win over the environment), so a box with the overlay
    // named in .env would still only ever run the plain stack. auto-apply.sh
    // is the one script in this bundle allowed a `-f` of its own at all, and
    // only as its OWN fallback for when .env sets no COMPOSE_FILE — never by
    // reading COMPOSE_FILE's content and rebuilding a file list from it.
    assert.match(autoApplySh, /if\s*\[\s*-n\s*"\$COMPOSE_FILE"\s*\]\s*;\s*then/);
    assert.match(autoApplySh, /COMPOSE=\(\)/, 'no -f when .env sets COMPOSE_FILE');
    assert.match(autoApplySh, /COMPOSE=\(-f docker-compose\.yml\)/, 'its own -f docker-compose.yml fallback when .env sets none');
    // It reads COMPOSE_FILE's presence the same careful way it already reads
    // TRACK_BRANCH -- a single well-formed line, never the whole .env (which
    // would pull the Porkbun credentials and the operator token into this
    // script's environment for no reason).
    assert.match(autoApplySh, /COMPOSE_FILE=\$\(sed -n 's\/\^\[\[:space:\]\]\*COMPOSE_FILE/);
  });

  for (const name of ['bootstrap.sh', 'pull-images.sh', 'init-letsencrypt.sh']) {
    it(`${name} names no docker-compose.yml of its own`, () => {
      assert.doesNotMatch(read(name), /-f\s+docker-compose\.yml/);
    });
  }
});

// This describe block is a SHAPE check only: it holds that each script names
// SHARED_EDGE at all, and where. The actual runtime behaviour — render.sh
// really skipping DNS_PROVIDER and really removing a stale dns-01.env /
// nginx conf, and init-letsencrypt.sh really touching no docker call — is run
// for real, against the real scripts, in render.test.mjs's "SHARED_EDGE"
// describe block and init-letsencrypt.test.mjs's SHARED_EDGE=1 case
// respectively. bootstrap.sh has no real-execution harness anywhere in this
// suite (it provisions a host: ufw, docker, systemd), so its SHARED_EDGE
// check stays a shape check here, same depth as every other bootstrap.sh
// assertion in this file.
describe('cert work is skipped under the shared edge (SHARED_EDGE=1)', () => {
  it('render.sh cross-checks SHARED_EDGE against COMPOSE_FILE, the way the provider bundle checks HIDDEN', () => {
    assert.match(renderSh, /SHARED_EDGE/);
    assert.match(renderSh, /docker-compose\.shared-edge\.yml/);
    assert.match(renderSh, /COMPOSE_FILE/);
  });

  it('render.sh names the DNS_PROVIDER requirement as conditional on SHARED_EDGE (render.test.mjs proves the behaviour)', () => {
    const guarded = renderSh.slice(renderSh.indexOf('DNS_PROVIDER:?'));
    assert.match(guarded, /SHARED_EDGE/);
  });

  it('bootstrap.sh skips init-letsencrypt.sh under SHARED_EDGE=1', () => {
    assert.match(bootstrapSh, /SHARED_EDGE/);
    const tlsStep = bootstrapSh.slice(bootstrapSh.indexOf('TLS'));
    assert.match(tlsStep, /SHARED_EDGE.*=.*1/);
    assert.match(tlsStep, /init-letsencrypt\.sh/);
  });

  it('bootstrap.sh refuses to start when SHARED_EDGE=1 and the external `edge-gateway` network does not exist yet', () => {
    const startStep = bootstrapSh.slice(bootstrapSh.indexOf('Pull and start'));
    assert.match(startStep, /docker network inspect edge-gateway/);
    assert.match(startStep, /toon-protocol\/infra#24/);
  });

  it('auto-apply.sh never tries to reload a disabled nginx under SHARED_EDGE=1', () => {
    // The bug this guards: render.sh removes nginx/conf.d/node.conf under
    // SHARED_EDGE=1, so an unguarded `!cmp` of two missing files reads as
    // "differs" on every run and would try to reload a container that was
    // never started, every five minutes, forever.
    const reloadStep = autoApplySh.slice(autoApplySh.indexOf('nginx holds the rendered server names'));
    assert.match(reloadStep, /if\s*\[\s*-f\s+nginx\/conf\.d\/node\.conf\s*\]/);
  });

  it('init-letsencrypt.sh refuses to spend a Let\'s Encrypt call under SHARED_EDGE=1', () => {
    assert.match(initLetsencryptSh, /SHARED_EDGE/);
  });
});

// ── The auto-apply units are per node (shared contract v2 point 2) ──────────
// Several nodes can end up on one host (toon-protocol/infra#25), so a shared
// systemd instance needs unit names, and a lock path, that do not collide
// across them -- unqualified `toon-auto-apply.*` no longer ships.
describe('the auto-apply units are named per node', () => {
  it('ships toon-auto-apply-gateway.service and .timer, and no unqualified toon-auto-apply.* file', () => {
    assert.doesNotMatch(read('toon-auto-apply-gateway.service'), /^\s*$/);
    assert.doesNotMatch(read('toon-auto-apply-gateway.timer'), /^\s*$/);
    assert.throws(() => read('toon-auto-apply.service'), 'the unqualified unit file must not ship any more');
    assert.throws(() => read('toon-auto-apply.timer'), 'the unqualified unit file must not ship any more');
  });

  it('the timer points at the per-node service', () => {
    assert.match(read('toon-auto-apply-gateway.timer'), /^Unit=toon-auto-apply-gateway\.service$/m);
  });

  it('bootstrap.sh installs and enables the per-node names, never the unqualified ones', () => {
    assert.match(bootstrapSh, /install -m 644 toon-auto-apply-gateway\.service \/etc\/systemd\/system\/toon-auto-apply-gateway\.service/);
    assert.match(bootstrapSh, /install -m 644 toon-auto-apply-gateway\.timer\s+\/etc\/systemd\/system\/toon-auto-apply-gateway\.timer/);
    assert.match(bootstrapSh, /systemctl enable --now toon-auto-apply-gateway\.timer/);
    assert.doesNotMatch(bootstrapSh, /toon-auto-apply\.(service|timer)/);
  });

  it('auto-apply.sh takes its lock at the per-node path by default', () => {
    assert.match(autoApplySh, /LOCK_FILE=\$\{TOON_AUTOAPPLY_LOCK:-\/var\/lock\/toon-auto-apply-gateway\.lock\}/);
  });

  it('README documents the one-time migration off the old unqualified units', () => {
    assert.match(readme, /toon-auto-apply-gateway\.(service|timer)/);
    assert.match(readme, /systemctl disable --now toon-auto-apply\.timer/);
  });
});
