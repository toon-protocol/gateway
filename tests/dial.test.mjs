// The one seam every outbound connection goes through, and what it refuses.
//
// Everything about dialling THROUGH a proxy is proven at the gateway's own
// port in `hidden.test.mjs`. What is here is the seam's contract: which hosts
// are the proxy's, and that having no proxy is a refusal by name rather than
// a dial that fails.

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { connect as netConnect } from 'node:net';
import { describe, it } from 'node:test';
import { createServer as createTlsServer } from 'node:tls';

import { NoProxyError, connectionOptions, createDialer, isAnyoneHost, refusalFor } from '../src/dial.mjs';

describe('isAnyoneHost', () => {
  it('is any name under .anyone, whatever its case, with or without a trailing dot', () => {
    assert.equal(isAnyoneHost(`${'k'.repeat(56)}.anyone`), true);
    assert.equal(isAnyoneHost('Lease.ANYONE'), true);
    assert.equal(isAnyoneHost('lease.anyone.'), true);
  });

  it('is not an ordinary host, an address, or a name that merely contains it', () => {
    for (const host of ['203.0.113.7', '::1', '[::1]', 'example.com', 'anyone.example', 'notanyone', 'lease.anyone.example.com', undefined]) {
      assert.equal(isAnyoneHost(host), false, String(host));
    }
  });
});

describe('createDialer', () => {
  it('dials any host that is not .anyone directly, proxy or no proxy', () => {
    assert.equal(createDialer().connect('203.0.113.7', 80), undefined);
    assert.equal(createDialer({ socksProxy: 'socks5h://127.0.0.1:9050' }).connect('example.com', 443), undefined);
  });

  it('refuses an .anyone host by name when it has no proxy, before anything is tried', () => {
    const host = `${'k'.repeat(56)}.anyone`;
    assert.throws(() => createDialer().connect(host, 8080), (e) => {
      assert.ok(e instanceof NoProxyError);
      assert.equal(e.host, host);
      assert.equal(e.port, 8080);
      assert.match(e.message, /TOON_SOCKS_PROXY/);
      return true;
    });
  });

  it('refuses a proxy that is not socks5h, so a name is never resolved on this side', () => {
    assert.throws(() => createDialer({ socksProxy: 'socks5://127.0.0.1:9050' }), /socks5h/);
  });
});

describe('refusalFor', () => {
  it('turns a refused dial into the no_proxy reason, naming the address that needed it', () => {
    const why = refusalFor(new NoProxyError('lease.anyone', 8080), 'bb'.repeat(32));
    assert.equal(why?.reason, 'no_proxy');
    assert.equal(why?.status, 503);
    assert.match(why?.message ?? '', /lease\.anyone:8080/);
    assert.match(why?.message ?? '', /TOON_SOCKS_PROXY/);
    assert.match(why?.message ?? '', /bb{63}/);
  });

  it('leaves a dial that was made and merely failed to member_unreachable', () => {
    assert.equal(refusalFor(new Error('ECONNREFUSED'), 'bb'.repeat(32)), undefined);
  });
});

describe('connectionOptions', () => {
  it('hands the caller\'s pool to http.request for a direct dial, or no pool at all', () => {
    const agent = /** @type {any} */ ({ pool: true });
    assert.deepEqual(connectionOptions(() => undefined, 'example.com', 80, agent), { agent });
    assert.deepEqual(connectionOptions(undefined, 'example.com', 80, undefined), { agent: false });
  });

  it('gives http.request a createConnection that waits for the dial, and reports its failure', async () => {
    const socket = /** @type {any} */ ({ dialled: true });
    const made = connectionOptions(() => Promise.resolve(socket), 'lease.anyone', 80, undefined);
    assert.ok('createConnection' in made && typeof made.createConnection === 'function');
    const given = await new Promise((resolve) => made.createConnection({}, (e, s) => resolve([e, s])));
    assert.deepEqual(given, [null, socket]);

    const failed = connectionOptions(() => Promise.reject(new Error('no circuit')), 'lease.anyone', 80, undefined);
    assert.ok('createConnection' in failed && typeof failed.createConnection === 'function');
    const [e] = await new Promise((resolve) => failed.createConnection({}, (e, s) => resolve([e, s])));
    assert.match(e.message, /no circuit/);
  });

  it('puts TLS on a proxied socket for an https destination, rather than plaintext on the circuit', async (t) => {
    // A TLS server with the test certificate. A handshake that RUNS is refused
    // by the client, because nothing vouches for a self-signed certificate —
    // which is the proof: plaintext would have been handed back with no error.
    const fixture = (name) => readFileSync(new URL(`./fixtures/tls/${name}`, import.meta.url));
    const server = createTlsServer({ cert: fixture('gw.test.cert.pem'), key: fixture('gw.test.key.pem') });
    server.on('tlsClientError', () => {});
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
    t.after(() => server.close());
    const { port } = /** @type {{ port: number }} */ (server.address());

    const made = connectionOptions(() => Promise.resolve(netConnect(port, '127.0.0.1')), 'lease.anyone', port, undefined, { secure: true });
    assert.ok('createConnection' in made && typeof made.createConnection === 'function');
    const [e, socket] = await new Promise((resolve) => made.createConnection({}, (e, s) => resolve([e, s])));
    assert.equal(socket, undefined);
    assert.match(String(e?.code ?? e?.message), /SELF_SIGNED|UNABLE_TO_VERIFY|CERT/, 'the TLS handshake ran, and was verified');
  });

  it('lets a refusal through as a throw, so the tenant is answered before any request exists', () => {
    const { connect } = createDialer();
    assert.throws(() => connectionOptions(connect, 'lease.anyone', 80, undefined), NoProxyError);
  });
});
