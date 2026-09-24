// The DNS-01 hooks, against a stub instead of a DNS provider.
//
// Nothing here may call a real DNS API: CI has no credentials, and a test that
// wrote TXT records into somebody's zone would be a worse bug than the ones it
// caught. So each case loads the real hook file into python3, swaps
// `urllib.request.urlopen` for a recorder that answers like the provider's
// API, and runs the hook's own `auth` and `cleanup` — the functions certbot's
// `--manual-*-hook` commands reach. What is asserted is the requests the hook
// built: method, URL, headers and body.
//
// The propagation wait is stubbed too (`visible` answers yes at once): it asks
// public DNS whether the record is there, which a stub zone never is.
//
// It needs python3, which the hooks themselves need in the certbot image.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOKEN = 'cf-secret-token-never-printed';
const ZONE_ID = '023e105f4ecef8ad9ca31a8372d0c353';

const scratch = [];
after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

// Loads the hook, stubs its network, runs one phase per argv entry, and prints
// every request it made as JSON on stdout. The stub answers from ANSWERS,
// matched on "<METHOD> <path>" with any query string dropped; a list of
// answers is handed out one per call.
const HARNESS = String.raw`
import importlib.util, io, json, os, sys, urllib.error, urllib.request

hook_path, state_dir, answers = sys.argv[1], sys.argv[2], json.loads(sys.argv[3])
spec = importlib.util.spec_from_file_location("hook", hook_path)
hook = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hook)
hook.STATE_DIR = state_dir
hook.visible = lambda name, value: True

seen = []

class Answer(io.BytesIO):
    def __enter__(self): return self
    def __exit__(self, *a): return False

def urlopen(request, timeout=None):
    body = request.data.decode() if request.data else None
    seen.append({
        "method": request.get_method(),
        "url": request.full_url,
        "headers": {k.lower(): v for k, v in request.header_items()},
        "body": json.loads(body) if body else None,
    })
    path = request.full_url.split("/client/v4", 1)[-1].split("?", 1)[0]
    answer = answers.get(request.get_method() + " " + path, [200, {"success": True, "result": {}}])
    # A list of answers is a queue: one per call, in order.
    status, payload = answer.pop(0) if isinstance(answer[0], list) else answer
    raw = json.dumps(payload).encode()
    if status >= 400:
        raise urllib.error.HTTPError(request.full_url, status, "err", {}, io.BytesIO(raw))
    return Answer(raw)

hook.urllib.request.urlopen = urlopen
code = 0
try:
    for phase, domain, validation in json.loads(os.environ["PHASES"]):
        os.environ["CERTBOT_DOMAIN"] = domain
        os.environ["CERTBOT_VALIDATION"] = validation
        getattr(hook, phase)()
except SystemExit as exit:
    code = exit.code or 0
print(json.dumps(seen))
sys.exit(code)
`;

/** Runs the named hook through the phases, against a stub that gives `answers`. */
function hook(name, { env, phases, answers = {} }) {
  const state = mkdtempSync(join(tmpdir(), `dns01-${name}-`));
  scratch.push(state);
  const result = spawnSync(
    'python3',
    ['-c', HARNESS, join(HERE, 'certbot', `${name}.py`), state, JSON.stringify(answers)],
    {
      encoding: 'utf8',
      // No __pycache__ beside the hook: it would dirty the checkout a box
      // follows, and auto-apply.sh stops on a dirty tree.
      env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: '1', ...env, PHASES: JSON.stringify(phases) },
    },
  );
  const lastLine = result.stdout.trim().split('\n').pop() || '[]';
  return { status: result.status, stderr: result.stderr, requests: JSON.parse(lastLine) };
}

const CLOUDFLARE = { CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ZONE: 'acme.example' };
const ZONE_LOOKUP = { 'GET /zones': [200, { success: true, result: [{ id: ZONE_ID, name: 'acme.example' }] }] };
const created = (id) => [200, { success: true, result: { id } }];

describe('certbot/cloudflare.py', () => {
  it('needs python3, as the certbot image has', () => {
    assert.equal(spawnSync('python3', ['--version']).status, 0, 'python3 is missing');
  });

  it('looks the zone up by name, then publishes the challenge as a TXT record', () => {
    const { status, stderr, requests } = hook('cloudflare', {
      env: CLOUDFLARE,
      phases: [['auth', 'gw.acme.example', 'token-A']],
      answers: { ...ZONE_LOOKUP, [`POST /zones/${ZONE_ID}/dns_records`]: created('rec-1') },
    });
    assert.equal(status, 0, stderr);
    assert.equal(requests.length, 2);

    const [lookup, create] = requests;
    assert.equal(lookup.method, 'GET');
    assert.equal(lookup.url, 'https://api.cloudflare.com/client/v4/zones?name=acme.example');

    assert.equal(create.method, 'POST');
    assert.equal(create.url, `https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records`);
    // Cloudflare takes the record name fully qualified.
    assert.deepEqual(create.body, { type: 'TXT', name: '_acme-challenge.gw.acme.example', content: 'token-A', ttl: 120 });
    for (const request of requests) {
      assert.equal(request.headers.authorization, `Bearer ${TOKEN}`);
      assert.equal(request.headers['content-type'], 'application/json');
    }
  });

  it('skips the lookup when CLOUDFLARE_ZONE_ID is given', () => {
    const { status, stderr, requests } = hook('cloudflare', {
      env: { ...CLOUDFLARE, CLOUDFLARE_ZONE_ID: 'given-zone-id' },
      phases: [['auth', 'gw.acme.example', 'token-A']],
      answers: { 'POST /zones/given-zone-id/dns_records': created('rec-1') },
    });
    assert.equal(status, 0, stderr);
    assert.deepEqual(requests.map((r) => `${r.method} ${r.url}`), [
      'POST https://api.cloudflare.com/client/v4/zones/given-zone-id/dns_records',
    ]);
  });

  it('deletes BY ID every record it made, including two on one name for `x` and `*.x`', () => {
    // certbot runs auth once per name — `gw.acme.example` and
    // `*.gw.acme.example` share the record name — then cleanup once per name.
    const { status, stderr, requests } = hook('cloudflare', {
      env: CLOUDFLARE,
      phases: [
        ['auth', 'gw.acme.example', 'token-bare'],
        ['auth', 'gw.acme.example', 'token-wild'],
        ['cleanup', 'gw.acme.example', 'token-bare'],
        ['cleanup', 'gw.acme.example', 'token-wild'],
      ],
      answers: {
        ...ZONE_LOOKUP,
        [`POST /zones/${ZONE_ID}/dns_records`]: [created('rec-bare'), created('rec-wild')],
      },
    });
    assert.equal(status, 0, stderr);
    const deletes = requests.filter((r) => r.method === 'DELETE');
    // Both ids were remembered under the one name, so the first cleanup
    // deletes both and the second finds nothing left to undo.
    assert.deepEqual(deletes.map((r) => r.url), [
      `https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records/rec-bare`,
      `https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records/rec-wild`,
    ]);
    for (const request of deletes) assert.equal(request.body, null);
  });

  it('treats a cleanup with no auth behind it as nothing to undo', () => {
    const { status, requests } = hook('cloudflare', {
      env: CLOUDFLARE,
      phases: [['cleanup', 'gw.acme.example', 'token-A']],
    });
    assert.equal(status, 0);
    assert.deepEqual(requests, []);
  });

  it("fails naming Cloudflare's error, and never prints the token", () => {
    const { status, stderr } = hook('cloudflare', {
      env: CLOUDFLARE,
      phases: [['auth', 'gw.acme.example', 'token-A']],
      answers: {
        ...ZONE_LOOKUP,
        [`POST /zones/${ZONE_ID}/dns_records`]: [403, { success: false, errors: [{ code: 10000, message: 'Authentication error' }] }],
      },
    });
    assert.notEqual(status, 0);
    assert.match(stderr, /POST \/zones\/[0-9a-f]+\/dns_records was refused: 10000 Authentication error/);
    assert.ok(!stderr.includes(TOKEN), 'the token reached stderr');
  });

  it('refuses a zone the token cannot see, rather than writing somewhere else', () => {
    const { status, stderr, requests } = hook('cloudflare', {
      env: CLOUDFLARE,
      phases: [['auth', 'gw.acme.example', 'token-A']],
      answers: { 'GET /zones': [200, { success: true, result: [] }] },
    });
    assert.notEqual(status, 0);
    assert.match(stderr, /no zone named acme\.example is visible to this token/);
    assert.equal(requests.filter((r) => r.method === 'POST').length, 0);
  });

  it('refuses a domain outside CLOUDFLARE_ZONE before calling anything', () => {
    const { status, stderr, requests } = hook('cloudflare', {
      env: CLOUDFLARE,
      phases: [['auth', 'gw.other.example', 'token-A']],
    });
    assert.notEqual(status, 0);
    assert.match(stderr, /gw\.other\.example is not under the zone acme\.example/);
    assert.deepEqual(requests, []);
  });

  it('refuses to run without its token', () => {
    const { status, stderr } = hook('cloudflare', {
      env: { CLOUDFLARE_ZONE: 'acme.example' },
      phases: [['auth', 'gw.acme.example', 'token-A']],
      answers: ZONE_LOOKUP,
    });
    assert.notEqual(status, 0);
    assert.match(stderr, /CLOUDFLARE_API_TOKEN is not set/);
  });
});
