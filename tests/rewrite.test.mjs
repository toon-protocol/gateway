// Dial rewrites: an advertised address dialled somewhere else, at the one
// seam every outbound connection goes through.

import { strict as assert } from 'node:assert';
import { createServer } from 'node:net';
import { describe, it } from 'node:test';

import { readConfig } from '../src/config.mjs';
import { createDialer } from '../src/dial.mjs';
import { readDialRewrites, rewriteTarget, withDialRewrites } from '../src/rewrite.mjs';
import { startStubSocks } from './helpers/stub-socks.mjs';

describe('readDialRewrites', () => {
  it('reads host and host:port on either side', () => {
    const rewrites = readDialRewrites(
      '{"provider-connector:3000":"provider:8080","127.0.0.1":"host.docker.internal","[::1]:80":"[fe80::1]"}',
    );
    assert.deepEqual(rewrites.get('provider-connector:3000'), { host: 'provider', port: 8080 });
    assert.deepEqual(rewrites.get('127.0.0.1'), { host: 'host.docker.internal', port: undefined });
    assert.deepEqual(rewrites.get('::1:80'), { host: 'fe80::1', port: undefined });
  });

  it('refuses what is not a map of endpoints, naming the entry', () => {
    assert.throws(() => readDialRewrites('nope'), /not JSON/);
    assert.throws(() => readDialRewrites('[]'), /JSON object/);
    assert.throws(() => readDialRewrites('{"a:b:c":"d"}'), /"a:b:c"/);
    assert.throws(() => readDialRewrites('{"a":""}'), /value for "a"/);
    assert.throws(() => readDialRewrites('{"a:70000":"b"}'), /port that is not one/);
  });
});

describe('rewriteTarget', () => {
  const rewrites = readDialRewrites('{"a.example:3000":"b.example:8080","127.0.0.1":"host.docker.internal"}');

  it('takes the exact host:port entry over the bare host entry, and leaves the rest alone', () => {
    assert.deepEqual(rewriteTarget(rewrites, 'a.example', 3000), { host: 'b.example', port: 8080 });
    assert.deepEqual(rewriteTarget(rewrites, 'A.EXAMPLE', 3000), { host: 'b.example', port: 8080 }, 'case-insensitively');
    assert.deepEqual(rewriteTarget(rewrites, 'a.example', 3001), { host: 'a.example', port: 3001 }, 'another port is not the entry');
    assert.deepEqual(rewriteTarget(rewrites, 'c.example', 80), { host: 'c.example', port: 80 });
  });

  it('keeps the port asked for when the entry names none', () => {
    assert.deepEqual(rewriteTarget(rewrites, '127.0.0.1', 41007), { host: 'host.docker.internal', port: 41007 });
  });
});

describe('withDialRewrites', () => {
  it('dials the rewritten target, and the same dialler otherwise', async () => {
    const server = createServer((socket) => socket.end('hello from the rewritten target'));
    await new Promise((ready) => server.listen(0, '127.0.0.1', () => ready(undefined)));
    const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
    try {
      const rewrites = readDialRewrites(`{"never.resolves.invalid:80":"127.0.0.1:${port}"}`);
      const dialer = withDialRewrites(createDialer(), rewrites);

      const dialling = dialer.connect('never.resolves.invalid', 80);
      assert.ok(dialling, 'a rewritten dial is made here, so the caller cannot dial the advertised name');
      const socket = await dialling;
      const heard = await new Promise((resolve, reject) => {
        const chunks = [];
        socket.on('data', (chunk) => chunks.push(chunk));
        socket.on('end', () => resolve(Buffer.concat(chunks).toString()));
        socket.on('error', reject);
      });
      assert.equal(heard, 'hello from the rewritten target');

      assert.equal(dialer.connect('never.resolves.invalid', 81), undefined, 'another port: the ordinary direct dial');
      assert.equal(dialer.connect('elsewhere.invalid', 80), undefined, 'another host: the ordinary direct dial');
    } finally {
      server.close();
    }
  });

  // A rewrite decides WHERE the socket goes, never whether an `.anyone` name
  // may be resolved here (spec §12.8): an `.anyone` host nobody rewrote still
  // goes to the proxy as a name, and an `.anyone` host the operator pointed at
  // a real address is that address's dial, not a hidden one.
  it('leaves an .anyone host to the proxy, and dials a rewrite off one directly', async () => {
    const server = createServer((socket) => socket.end('hello from the rewritten target'));
    await new Promise((ready) => server.listen(0, '127.0.0.1', () => ready(undefined)));
    const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
    const proxy = await startStubSocks({ routes: {} });
    try {
      const dialer = withDialRewrites(
        createDialer({ socksProxy: `socks5h://127.0.0.1:${proxy.port}` }),
        readDialRewrites(`{"x.anyone:80":"127.0.0.1:${port}"}`),
      );

      await assert.rejects(
        () => /** @type {Promise<unknown>} */ (dialer.connect('y.anyone', 80)),
        'nobody rewrote it, so it went to the proxy, which has no route for it',
      );
      assert.ok(
        proxy.askedFor('y.anyone', 80),
        `the proxy was asked for y.anyone:80 by name; it saw ${JSON.stringify(proxy.destinations)}`,
      );

      const socket = await dialer.connect('x.anyone', 80);
      assert.ok(socket, 'the rewritten one is dialled where the operator said');
      await new Promise((done) => {
        socket.resume();
        socket.once('end', done);
      });
      socket.destroy();
      assert.equal(
        proxy.askedFor('x.anyone', 80),
        false,
        `a rewrite off an .anyone name is an ordinary dial; the proxy saw ${JSON.stringify(proxy.destinations)}`,
      );
    } finally {
      await proxy.close();
      server.close();
    }
  });

  it('is the same dialler when there is nothing to rewrite', () => {
    const dialer = createDialer();
    assert.equal(withDialRewrites(dialer, new Map()), dialer);
  });
});

describe('readConfig with GATEWAY_DIAL_REWRITE', () => {
  const complete = {
    GATEWAY_DOMAIN: 'gw.example',
    GATEWAY_RELAYS: 'ws://relay.one:7100',
    GATEWAY_HANDOVER_PORT: '0',
    GATEWAY_HTTP_PORT: '0',
  };

  it('is empty unless set', () => {
    assert.equal(readConfig(complete).dialRewrites.size, 0);
    assert.equal(readConfig({ ...complete, GATEWAY_DIAL_REWRITE: ' ' }).dialRewrites.size, 0);
  });

  it('reads the map, and refuses a malformed one by name', () => {
    const config = readConfig({ ...complete, GATEWAY_DIAL_REWRITE: '{"a:1":"b:2"}' });
    assert.deepEqual(config.dialRewrites.get('a:1'), { host: 'b', port: 2 });
    assert.throws(() => readConfig({ ...complete, GATEWAY_DIAL_REWRITE: '{' }), /GATEWAY_DIAL_REWRITE/);
  });
});
