// TLS, terminated here (ADR 0013).
//
// The point of the gateway owning TLS is that a workload is reachable over
// HTTPS while holding no certificate itself, and no provider in the Standby
// Set ever sees a certificate key. So the certificate a tenant's browser
// validates is THIS gateway's, for THIS gateway's domain.

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { request as httpsRequest } from 'node:https';

import { CONSTANTS, gatewayGrant } from './helpers/events.mjs';
import { DOMAIN, startTestGateway } from './helpers/harness.mjs';

const GATEWAY = CONSTANTS.gateway.public_key;
const WORKLOAD = 'aa'.repeat(32);
const grantFor = () => gatewayGrant({ workloadId: WORKLOAD, gateway: GATEWAY });

/** @type {import('../src/serve.mjs').Resolver} */
const served = async ({ grant, res }) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end(`served ${grant.workloadId}`);
  return { served: true };
};

/** One HTTPS request, keeping hold of the certificate that was presented. */
const overTls = ({ port, host }) =>
  new Promise((resolve, reject) => {
    const req = httpsRequest(
      { host: '127.0.0.1', port, path: '/', servername: host, rejectUnauthorized: false, headers: { host } },
      (res) => {
        const certificate = /** @type {import('node:tls').TLSSocket} */ (res.socket).getPeerCertificate();
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8'), certificate }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });

describe('TLS', () => {
  it('serves a granted workload over HTTPS with the configured certificate', async (t) => {
    const gateway = await startTestGateway({ events: [grantFor()], tls: true, http: false, resolve: served });
    t.after(() => gateway.close());

    assert.equal(gateway.httpPort, null, 'no plain listener unless one was asked for');
    const answered = await overTls({ port: gateway.httpsPort, host: gateway.hostFor(WORKLOAD) });
    assert.equal(answered.status, 200);
    assert.match(answered.body, new RegExp(WORKLOAD));
    assert.equal(answered.certificate.subject.CN, `*.${DOMAIN}`, 'the GATEWAY\'s certificate');
  });

  it('answers the gateway error page over HTTPS too', async (t) => {
    const gateway = await startTestGateway({ tls: true, http: false, resolve: served });
    t.after(() => gateway.close());

    const answered = await overTls({ port: gateway.httpsPort, host: gateway.hostFor('bb'.repeat(32)) });
    assert.equal(answered.status, 503);
    assert.equal(answered.headers['toon-gateway-reason'], 'no_grant');
  });

  it('runs the plain development listener beside TLS when both are configured', async (t) => {
    const gateway = await startTestGateway({ events: [grantFor()], tls: true, http: true, resolve: served });
    t.after(() => gateway.close());

    assert.ok(gateway.httpPort, 'a development listener');
    assert.ok(gateway.httpsPort, 'and TLS beside it');

    const host = gateway.hostFor(WORKLOAD);
    const plain = await gateway.get(host, { tls: false });
    const secure = await overTls({ port: gateway.httpsPort, host });
    assert.equal(plain.status, 200);
    assert.equal(secure.status, 200);
    assert.equal(plain.body, secure.body, 'the same workload, whichever listener answered');
  });
});
