// The gateway's own error vocabulary: why a workload is not being served.

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { REASONS, defineReason, renderUnavailable, unavailable } from '../src/reasons.mjs';

describe('unavailable', () => {
  it('names the reason in words, not only in code', () => {
    const why = unavailable('no_grant', { host: 'abc.gw.example' });
    assert.equal(why.reason, 'no_grant');
    assert.equal(why.status, 503);
    assert.match(why.message, /no grant/i);
    assert.match(why.message, /abc\.gw\.example/);
  });

  it('tells an expired grant apart from a missing one', () => {
    const expired = unavailable('grant_expired', { workloadId: 'aa'.repeat(32), expiresAt: 1700086400 });
    assert.equal(expired.reason, 'grant_expired');
    assert.match(expired.message, /expired/i);
    assert.notEqual(expired.message, unavailable('no_grant', { host: 'x' }).message);
  });

  it('refuses a reason nobody defined, rather than answering a blank page', () => {
    assert.throws(() => unavailable('made_up', {}), /made_up/);
  });
});

describe('renderUnavailable', () => {
  it('answers JSON in the shape every other TOON Network error uses', () => {
    const rendered = renderUnavailable(unavailable('no_grant', { host: 'abc.gw.example' }), '*/*');
    assert.equal(rendered.status, 503);
    assert.match(rendered.contentType, /^application\/json/);
    assert.deepEqual(Object.keys(JSON.parse(rendered.body)).sort(), ['error', 'message']);
    assert.equal(JSON.parse(rendered.body).error, 'no_grant');
  });

  it('answers a page a person can read when a browser asks for one', () => {
    const rendered = renderUnavailable(unavailable('no_grant', { host: 'abc.gw.example' }), 'text/html');
    assert.match(rendered.contentType, /^text\/html/);
    assert.match(rendered.body, /no_grant/);
    assert.match(rendered.body, /abc\.gw\.example/);
  });

  it('escapes what came from the request, so a hostname cannot write the page', () => {
    const rendered = renderUnavailable(
      unavailable('no_grant', { host: '<script>x</script>.gw.example' }),
      'text/html',
    );
    assert.doesNotMatch(rendered.body, /<script>/);
    assert.match(rendered.body, /&lt;script&gt;/);
  });
});

describe('defineReason', () => {
  // This is the seam M5-4 and M5-6 extend: a reason is a row in one table.
  it('adds a reason the rest of the gateway can raise by name', () => {
    defineReason('a_later_ticket', ({ member }) => `member ${member} said nothing`);
    try {
      assert.match(unavailable('a_later_ticket', { member: 'x' }).message, /member x said nothing/);
    } finally {
      delete REASONS.a_later_ticket;
    }
  });

  it('refuses to redefine a reason already in the vocabulary', () => {
    assert.throws(() => defineReason('no_grant', () => 'something else'), /already/);
  });
});
