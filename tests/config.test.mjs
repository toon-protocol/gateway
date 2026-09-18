// Configuration, and the refusal that names what is missing.
//
// A gateway that starts half-configured is worse than one that does not start:
// it answers a tenant's hostname with nothing, and the tenant cannot tell that
// from a stopped workload.

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { ADMIT_PER_MINUTE } from '../src/admit.mjs';
import { readConfig } from '../src/config.mjs';
import { FOLLOW_TICK_MS } from '../src/follow.mjs';

const files = { '/tls/cert.pem': 'CERT BYTES', '/tls/key.pem': 'KEY BYTES' };
const readFile = (path) => {
  if (!Object.hasOwn(files, path)) throw new Error(`ENOENT: no such file, open '${path}'`);
  return files[path];
};

const complete = {
  GATEWAY_DOMAIN: 'gw.example',
  GATEWAY_RELAYS: 'ws://relay.one:7100, ws://relay.two:7100',
  GATEWAY_HANDOVER_PORT: '7300',
  GATEWAY_TLS_CERT: '/tls/cert.pem',
  GATEWAY_TLS_KEY: '/tls/key.pem',
};

const read = (env) => readConfig(env, { readFile });
const refusal = (env) => {
  try {
    read(env);
    return '';
  } catch (e) {
    return e.message;
  }
};

describe('readConfig', () => {
  it('reads a complete production configuration', () => {
    const config = read(complete);
    assert.equal(config.domain, 'gw.example');
    assert.deepEqual(config.relays, ['ws://relay.one:7100', 'ws://relay.two:7100']);
    assert.equal(config.handoverPort, 7300);
    assert.equal(config.tls.cert, 'CERT BYTES');
    assert.equal(config.tls.key, 'KEY BYTES');
    assert.equal(config.httpsPort, 443);
    assert.equal(config.httpPort, null, 'no development listener unless one is asked for');
    assert.equal(config.socksProxy, undefined);
  });

  it('asks for no key at all: a gateway signs nothing and publishes nothing', () => {
    // Spec §12.1. What identifies this gateway to a tenant is the connector
    // the handover is sealed to, not a Nostr key it would have nothing to do
    // with — so there is none to leak, and none to configure.
    const config = read(complete);
    assert.doesNotMatch(JSON.stringify(Object.keys(config)), /secret|publicKey/i);
  });

  it('lowercases the domain, because DNS does', () => {
    assert.equal(read({ ...complete, GATEWAY_DOMAIN: 'GW.Example' }).domain, 'gw.example');
  });

  it('runs a plain HTTP listener for development in place of TLS', () => {
    const config = read({
      GATEWAY_DOMAIN: 'gw.example',
      GATEWAY_RELAYS: 'ws://relay.one:7100',
      GATEWAY_HANDOVER_PORT: '7300',
      GATEWAY_HTTP_PORT: '8080',
    });
    assert.equal(config.httpPort, 8080);
    assert.equal(config.tls, null);
  });

  it('runs both when both are configured', () => {
    const config = read({ ...complete, GATEWAY_HTTP_PORT: '8080' });
    assert.equal(config.httpPort, 8080);
    assert.ok(config.tls);
  });

  it('names every missing required key at once, not one per restart', () => {
    const why = refusal({});
    for (const key of ['GATEWAY_DOMAIN', 'GATEWAY_RELAYS', 'GATEWAY_HANDOVER_PORT']) {
      assert.match(why, new RegExp(key), key);
    }
  });

  it('refuses a gateway with nothing to listen on, naming both ways out', () => {
    const why = refusal({
      GATEWAY_DOMAIN: 'gw.example',
      GATEWAY_RELAYS: 'ws://relay.one:7100',
      GATEWAY_HANDOVER_PORT: '7300',
    });
    assert.match(why, /GATEWAY_TLS_CERT/);
    assert.match(why, /GATEWAY_HTTP_PORT/);
  });

  it('refuses half a certificate', () => {
    assert.match(refusal({ ...complete, GATEWAY_TLS_KEY: undefined }), /GATEWAY_TLS_KEY/);
    assert.match(refusal({ ...complete, GATEWAY_TLS_CERT: undefined }), /GATEWAY_TLS_CERT/);
  });

  it('refuses a certificate it cannot read, by path', () => {
    assert.match(refusal({ ...complete, GATEWAY_TLS_CERT: '/tls/missing.pem' }), /\/tls\/missing\.pem/);
  });

  it('refuses a relay that is not a websocket URL', () => {
    assert.match(refusal({ ...complete, GATEWAY_RELAYS: 'https://relay.one' }), /GATEWAY_RELAYS/);
  });

  it('refuses a domain that is not a domain', () => {
    assert.match(refusal({ ...complete, GATEWAY_DOMAIN: 'not a domain' }), /GATEWAY_DOMAIN/);
  });

  it('refuses a port that is not a port', () => {
    assert.match(refusal({ ...complete, GATEWAY_HTTPS_PORT: 'https' }), /GATEWAY_HTTPS_PORT/);
    assert.match(refusal({ ...complete, GATEWAY_HTTP_PORT: '70000' }), /GATEWAY_HTTP_PORT/);
    assert.match(refusal({ ...complete, GATEWAY_HANDOVER_PORT: 'seal' }), /GATEWAY_HANDOVER_PORT/);
  });
});

describe('how often one provider can be made to admit a handover', () => {
  // Anyone can seal a handover naming any provider, so one sealed packet buys
  // one free `status` per member it names (spec §12.1).
  it('defaults to a bounded rate, and takes a number a minute', () => {
    assert.equal(read(complete).admitPerMinute, ADMIT_PER_MINUTE);
    assert.equal(read({ ...complete, GATEWAY_ADMIT_PER_MINUTE: '2' }).admitPerMinute, 2);
  });

  it('refuses a rate that is not a number of admissions', () => {
    assert.match(refusal({ ...complete, GATEWAY_ADMIT_PER_MINUTE: 'lots' }), /GATEWAY_ADMIT_PER_MINUTE/);
    assert.match(refusal({ ...complete, GATEWAY_ADMIT_PER_MINUTE: '0' }), /GATEWAY_ADMIT_PER_MINUTE/);
  });
});

describe('how often it looks at the clock', () => {
  // A settle window and a Liveness cadence are counted in the grant's and the
  // Profile's own seconds (spec §12.7); this is only how late the gateway may
  // be in noticing that one has passed.
  it('defaults to a second, and takes a number of milliseconds', () => {
    assert.equal(read(complete).followTickMs, FOLLOW_TICK_MS);
    assert.equal(read({ ...complete, GATEWAY_FOLLOW_TICK_MS: '20' }).followTickMs, 20);
  });

  it('refuses a tick that is not a number of milliseconds', () => {
    assert.match(refusal({ ...complete, GATEWAY_FOLLOW_TICK_MS: 'often' }), /GATEWAY_FOLLOW_TICK_MS/);
    assert.match(refusal({ ...complete, GATEWAY_FOLLOW_TICK_MS: '0' }), /GATEWAY_FOLLOW_TICK_MS/);
  });
});

describe('the .anyone proxy', () => {
  // Accepted and validated here; `src/dial.mjs` is what dials through it.
  it('takes a socks5h proxy', () => {
    const config = read({ ...complete, TOON_SOCKS_PROXY: 'socks5h://anon:9050' });
    assert.equal(config.socksProxy, 'socks5h://anon:9050');
  });

  it('refuses socks5 without the h, rather than resolving a .anyone name here', () => {
    const why = refusal({ ...complete, TOON_SOCKS_PROXY: 'socks5://anon:9050' });
    assert.match(why, /TOON_SOCKS_PROXY/);
    assert.match(why, /socks5h/);
  });

  it('refuses a proxy naming no port', () => {
    assert.match(refusal({ ...complete, TOON_SOCKS_PROXY: 'socks5h://anon' }), /TOON_SOCKS_PROXY/);
  });
});
