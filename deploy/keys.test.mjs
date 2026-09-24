// keys.sh, run for real (TOON_Network#162).
//
// An operator funds exactly what `keys.sh addresses` prints, before anything
// has booted to disagree with it. A derivation wrong by one byte is money sent
// to a key nobody holds, and a connector that restart-loops on an empty wallet
// anyway. So every expected address below was produced by the CONNECTOR, on
// fixed test keys that hold nothing, and never by keys.py:
//
//   * keyids: `docker run --rm -v "$PWD:/d:ro"
//     ghcr.io/toon-protocol/connector:rust-2026.09.11.1 send --operator-key
//     /d/<file> --print-keyid`, this bundle's own connector pin.
//     settlement-solana.key goes through the same ed25519 expansion
//     (`read_settlement_key_bytes` -> solana-sdk `keypair_from_seed`), and the
//     base58 was checked with `solana-keygen pubkey`;
//   * EVM addresses: the connector's `connector_signer::derive_evm_address`
//     (lowercase, as `GET /ilp` prints it), with viem's EIP-55 casing.
//
// It then checks keys.py against @noble on keys it has never seen, and runs
// init, addresses and check-funded (against a stub Solana RPC) on a scratch
// copy of the bundle. The provider's tests/deploy_keys.rs pins the same
// file, plus the publisher and the npub, which a gateway does not have.
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { ed25519 } from '@noble/curves/ed25519.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const HERE = dirname(fileURLToPath(import.meta.url));

// [key file contents, --print-keyid, its base58]
const ED25519 = [
  // RFC 8032 §7.1 TEST 1, as `openssl rand -hex 32 >` writes a key: a newline.
  [
    '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60\n',
    'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
    'FVen3X669xLzsi6N2V91DoiyzHzg1uAgqiT8jZ9nS96Z',
  ],
  // RFC 8032 §7.1 TEST 2.
  [
    '4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb\n',
    '3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c',
    '586Z7H2vpX9qNhN2T4e9Utugie3ogjbxzGaMtM3E6HR5',
  ],
  // sha256("toon keys.sh pin"), no trailing newline.
  [
    '99fc2e314584c8249d9a5d40de9eba25fa49a644f90852aeb4bb343f60e9cc5f',
    '7862bef3863de3311d7ec63b54dd7f9b32100a2623b02363332dfd12be1f10a8',
    '96wFoBogqaCH9YgzTpvK6nySj5XsUsU2HbncEBHDnwZ9',
  ],
  // The other format the connector reads: exactly 32 raw bytes.
  [
    Buffer.alloc(32, 7),
    'ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c',
    'GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB',
  ],
];

// [settlement.key contents, the address the connector settles from, EIP-55]
const EVM = [
  // Anvil's first dev account: the vector every EVM tool agrees on.
  ['ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80\n', '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'],
  ['9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60\n', '0x09231da7b19A016f9e576d23B16277062F4d46A8'],
  ['99fc2e314584c8249d9a5d40de9eba25fa49a644f90852aeb4bb343f60e9cc5f', '0xf6888FB9CDfa10859FfCC366aD7AF9dF8208A096'],
];

const scratch = [];
after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function tempdir() {
  const dir = mkdtempSync(join(tmpdir(), 'gateway-keys-'));
  scratch.push(dir);
  return dir;
}

function derive(dir) {
  const run = spawnSync('python3', [join(HERE, 'keys.py'), 'gateway', 'derive'], { cwd: dir, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}

function withKeys(solana, evm, operator) {
  const dir = tempdir();
  writeFileSync(join(dir, 'settlement-solana.key'), solana);
  writeFileSync(join(dir, 'settlement.key'), evm);
  if (operator !== undefined) writeFileSync(join(dir, 'operator-write.key'), operator);
  return dir;
}

describe('every address keys.sh prints is the one the connector derives', () => {
  it('the Solana settlement address is its --print-keyid, in base58', () => {
    for (const [key, keyid, address] of ED25519) {
      const derived = derive(withKeys(key, EVM[0][0]));
      assert.equal(derived.connector_solana_hex, keyid);
      assert.equal(derived.connector_solana, address);
    }
  });

  it('the operator write key is what --print-keyid prints', () => {
    for (const [key, keyid] of ED25519) {
      assert.equal(derive(withKeys(ED25519[0][0], EVM[0][0], key)).operator_keyid, keyid);
    }
  });

  it('the EVM settlement address is the one it settles from', () => {
    for (const [key, address] of EVM) {
      assert.equal(derive(withKeys(ED25519[0][0], key)).connector_evm, address);
    }
  });

  it('agrees with @noble on keys it has never seen', () => {
    for (let i = 0; i < 8; i++) {
      const seed = randomBytes(32);
      const secret = bytesToHex(secp256k1.utils.randomSecretKey());
      const derived = derive(withKeys(`${seed.toString('hex')}\n`, `${secret}\n`));
      assert.equal(derived.connector_solana_hex, bytesToHex(ed25519.getPublicKey(seed)));
      const point = secp256k1.getPublicKey(Buffer.from(secret, 'hex'), false);
      const address = bytesToHex(keccak_256(point.slice(1)).slice(12));
      assert.equal(derived.connector_evm.toLowerCase(), `0x${address}`);
    }
  });
});

// ── keys.sh itself, on a scratch copy of the bundle ─────────────────────────

function bundle() {
  const dir = tempdir();
  for (const name of ['keys.sh', 'keys.py', '.env.example']) copyFileSync(join(HERE, name), join(dir, name));
  chmodSync(join(dir, 'keys.sh'), 0o755);
  return dir;
}

// Async, so a stub RPC in this same process can answer while it runs.
function keysSh(dir, ...args) {
  return new Promise((resolve) => {
    const child = spawn('bash', [join(dir, 'keys.sh'), ...args], { cwd: dir });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

/** .env as the shell reads it, the way bootstrap.sh and render.sh do. */
function sourced(dir, name) {
  return spawnSync('bash', ['-c', `set -a; . ./.env; set +a; printf %s "$${name}"`], { cwd: dir, encoding: 'utf8' })
    .stdout;
}

const HEX64 = /^[0-9a-f]{64}$/;

describe('keys.sh init', () => {
  it('generates what is missing, 0600, and prints the operator key once', async () => {
    const dir = bundle();
    const run = await keysSh(dir, 'init');
    assert.equal(run.status, 0, run.stderr);
    for (const key of ['signer.key', 'settlement.key', 'settlement-solana.key']) {
      assert.match(readFileSync(join(dir, key), 'utf8').trim(), HEX64);
      assert.equal(statSync(join(dir, key)).mode & 0o777, 0o600, key);
    }
    assert.match(sourced(dir, 'OPERATOR_BEARER_TOKEN'), HEX64);
    const operatorPublic = sourced(dir, 'OPERATOR_WRITE_KEY');
    assert.match(operatorPublic, HEX64);
    // A gateway has no Nostr identity and no publisher: init adds neither.
    assert.equal(sourced(dir, 'NOSTR_PRIVATE_KEY'), '');
    assert.equal(sourced(dir, 'PUBLISHER_MNEMONIC'), '');

    const privateHalf = run.stdout
      .split('\n')
      .map((l) => l.trim())
      .find((l) => HEX64.test(l));
    assert.ok(privateHalf, 'the private half is printed');
    assert.equal(bytesToHex(ed25519.getPublicKey(Buffer.from(privateHalf, 'hex'))), operatorPublic);
    for (const name of readdirSync(dir)) {
      assert.ok(!readFileSync(join(dir, name), 'utf8').includes(privateHalf), `${name} holds the private half`);
    }
  });

  it('never replaces a key, and a second run changes nothing', async () => {
    const dir = bundle();
    const mine = '4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb\n';
    writeFileSync(join(dir, 'signer.key'), mine);
    writeFileSync(
      join(dir, '.env'),
      readFileSync(join(dir, '.env.example'), 'utf8').replace('OPERATOR_BEARER_TOKEN=\n', 'OPERATOR_BEARER_TOKEN=mine\n'),
    );
    assert.equal((await keysSh(dir, 'init')).status, 0);
    assert.equal(readFileSync(join(dir, 'signer.key'), 'utf8'), mine);
    assert.equal(sourced(dir, 'OPERATOR_BEARER_TOKEN'), 'mine');

    const snapshot = () => Object.fromEntries(readdirSync(dir).map((n) => [n, readFileSync(join(dir, n), 'utf8')]));
    const before = snapshot();
    const again = await keysSh(dir, 'init');
    assert.equal(again.status, 0);
    assert.deepEqual(snapshot(), before);
    assert.ok(!again.stdout.split('\n').some((l) => HEX64.test(l.trim())), 'no private key on a re-run');
  });
});

describe('keys.sh addresses', () => {
  it('prints both addresses, in the form a faucet takes, and nothing to convert', async () => {
    const dir = bundle();
    assert.equal((await keysSh(dir, 'init')).status, 0);
    writeFileSync(join(dir, 'settlement-solana.key'), ED25519[0][0]);
    writeFileSync(join(dir, 'settlement.key'), EVM[0][0]);
    const run = await keysSh(dir, 'addresses');
    assert.equal(run.status, 0, run.stderr);
    assert.ok(run.stdout.includes(ED25519[0][2]), run.stdout);
    assert.ok(run.stdout.includes(EVM[0][1]), run.stdout);
    assert.ok(run.stdout.includes('https://faucet.solana.com'));
    assert.ok(!run.stdout.includes(ED25519[0][1]), 'no hex keyid is offered as an address');
    assert.ok(!run.stdout.includes('publisher'), 'a gateway has no publisher');
  });
});

/** A Solana JSON-RPC stub answering getBalance from `balances`. */
async function stubRpc(balances) {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const request = JSON.parse(body);
      const value = balances[request.params[0]] ?? 0;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { context: { slot: 1 }, value } }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

async function bundleOn(rpcUrl) {
  const dir = bundle();
  assert.equal((await keysSh(dir, 'init')).status, 0);
  writeFileSync(join(dir, 'settlement-solana.key'), ED25519[0][0]);
  writeFileSync(join(dir, '.env'), `${readFileSync(join(dir, '.env'), 'utf8')}SETTLEMENT_SOLANA_RPC_URL=${rpcUrl}\n`);
  return dir;
}

describe('keys.sh check-funded', () => {
  it('refuses an unfunded connector with the list', async () => {
    const dir = await bundleOn(await stubRpc({}));
    const run = await keysSh(dir, 'check-funded');
    assert.equal(run.status, 1);
    assert.ok(run.stdout.includes('REFUSED'));
    assert.ok(run.stdout.includes(ED25519[0][2]));
  });

  it('only warns on a box that is already up', async () => {
    const dir = await bundleOn(await stubRpc({}));
    const run = await keysSh(dir, 'check-funded', '--warn-only');
    assert.equal(run.status, 0);
    assert.ok(run.stdout.includes('::warning::'));
  });

  it('passes a funded connector', async () => {
    const dir = await bundleOn(await stubRpc({ [ED25519[0][2]]: 1_000_000_000 }));
    const run = await keysSh(dir, 'check-funded');
    assert.equal(run.status, 0, run.stdout);
  });

  it('warns, rather than refusing, when the RPC does not answer', async () => {
    const dir = await bundleOn('http://127.0.0.1:1');
    const run = await keysSh(dir, 'check-funded');
    assert.equal(run.status, 3);
    assert.ok(run.stdout.includes('::warning::'));
  });
});

describe('bootstrap.sh', () => {
  it('checks funding before it touches the host', () => {
    const bootstrap = readFileSync(join(HERE, 'bootstrap.sh'), 'utf8');
    const check = bootstrap.indexOf('./keys.sh check-funded');
    assert.ok(check > 0, 'bootstrap.sh runs keys.sh check-funded');
    assert.ok(check < bootstrap.indexOf('apt-get install -y ufw'), 'before anything is installed');
  });
});
