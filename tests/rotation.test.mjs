// A Standby Set whose Continuation Tokens were rotated under a grant this
// gateway holds (spec §6.8, §12.4, §12.1; TOON_Network #75).
//
// No gateway code knows about rotation, and none should: after a rotation
// every rotated member refuses a grant of the old token `bad_grant`, which
// §12.4 already counts as the member telling this gateway nothing, and a
// tenant that keeps the gateway seals a new handover whose grants derive from
// the new tokens, which the ordinary admission round admits and which
// replaces what was held. These tests pin that behaviour at the gateway's two
// doors, against members that check a presented grant the way a provider does
// (`asProvider`) and that refuse, once rotated, with the very body a real
// provider gave a grant of the replaced token (`error.bad_grant.rotated`).

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { CONSTANTS, providerProfile, wireFixture } from './helpers/events.mjs';
import { asProvider, gatewayHandover, gatewayWithdrawal, grantFrom } from './helpers/handover.mjs';
import { startTestGateway, until } from './helpers/harness.mjs';
import { running, startStubConnector } from './helpers/stub-connector.mjs';
import { startStubWorkload } from './helpers/stub-workload.mjs';

const PRIMARY = CONSTANTS.primary_provider;
const STANDBY = CONSTANTS.standby_provider;
const WORKLOAD = 'aa'.repeat(32);
const HTTP_PORT = 8080;
const CADENCE = 60;
const EXPIRES_AT = CONSTANTS.now + 86_400;

/** The root secret the lease was spawned from, and the fresh one a rotation minted. */
const OLD_ROOT = CONSTANTS.tenant.root_secret;
const NEW_ROOT = CONSTANTS.rotated_tenant.root_secret;

/** What a provider answered a grant of the token a rotation replaced. */
const BAD_GRANT_ROTATED = wireFixture('error.bad_grant.rotated');

/** The gateway looks at the clock this often; it decides nothing. */
const FOLLOWS_FAST = { GATEWAY_FOLLOW_TICK_MS: '20' };

const handoverFrom = (rootSecret) =>
  gatewayHandover({
    workloadId: WORKLOAD,
    httpPort: HTTP_PORT,
    standbySet: [PRIMARY.public_key, STANDBY.public_key],
    expiresAt: EXPIRES_AT,
    rootSecret,
  });

const withdrawalFrom = (rootSecret) =>
  gatewayWithdrawal({
    workloadId: WORKLOAD,
    standbySet: [PRIMARY.public_key, STANDBY.public_key],
    expiresAt: EXPIRES_AT,
    rootSecret,
  });

/**
 * One member of the Standby Set: a connector that reads the lease with the
 * token the CURRENT root secret derives for this member, and nothing else.
 * `rotate(root)` is a rotation at this member (§6.8): from then on it holds
 * the token `root` derives, and a grant of the old one is refused exactly as
 * the provider refused one in `error.bad_grant.rotated`.
 *
 * @param {import('node:test').TestContext} t
 * @param {{ public_key: string, secret_key: string }} key
 * @param {{ now: () => number, runs?: boolean, body?: string }} options
 */
async function member(t, key, { now, runs = false, body = 'the workload' }) {
  const workload = runs ? await startStubWorkload({ body }) : null;
  if (workload) t.after(() => workload.close());
  const connector = await startStubConnector({ pubkey: key.public_key });
  t.after(() => connector.close());

  const state = ({ workloadId }) =>
    runs
      ? running({ workloadId, host: '127.0.0.1', ports: [{ container_port: HTTP_PORT, host_port: workload?.port }] })
      : { workload_id: workloadId, role: 'standby', state: 'reserved', expires_at: CONSTANTS.now + 3600 };
  const holding = (rootSecret, rotated) => {
    const check = asProvider({ member: key.public_key, workloadId: WORKLOAD, rootSecret, now, answer: state });
    return (context) => {
      const answer = check(context);
      return rotated && answer.error === 'bad_grant' ? BAD_GRANT_ROTATED.response_body : answer;
    };
  };
  connector.answerWith(holding(OLD_ROOT, false));

  return {
    connector,
    profile: providerProfile({
      providerSecret: key.secret_key,
      connectorUrl: connector.url,
      relays: [],
      livenessCadenceS: CADENCE,
    }),
    rotate: (rootSecret) => connector.answerWith(holding(rootSecret, true)),
    /** The grant this member was last asked with. */
    lastGrant: () => connector.requests.at(-1)?.continuation,
    get asked() {
      return connector.requests.length;
    },
  };
}

/**
 * A gateway serving a two-member set under grants of `OLD_ROOT`, admitted by
 * the REAL round — the primary running the workload, the standby reserved —
 * and a clock the test moves.
 */
async function servedSet(t) {
  let clock = CONSTANTS.now;
  const now = () => clock;
  const primary = await member(t, PRIMARY, { now, runs: true, body: 'the primary\'s copy' });
  const standby = await member(t, STANDBY, { now });
  const gateway = await startTestGateway({
    events: [primary.profile, standby.profile],
    handovers: [handoverFrom(OLD_ROOT)],
    now,
    env: { ...FOLLOWS_FAST, GATEWAY_RESOLVE_TIMEOUT_MS: '500' },
  });
  t.after(() => gateway.close());
  const host = gateway.hostFor(WORKLOAD);
  assert.equal((await gateway.get(host)).body, 'the primary\'s copy', 'served under the old grants first');
  return {
    gateway,
    host,
    primary,
    standby,
    members: [primary, standby],
    /** Move the clock past a cadence, and wait until every member was asked again. */
    async nextCadence() {
      const before = [primary.asked, standby.asked];
      clock += CADENCE + 1;
      await until(() => primary.asked > before[0] && standby.asked > before[1], { what: 'the per-cadence re-ask' });
    },
  };
}

describe('the fixture a rotated member refuses with', () => {
  it('is a grant of the token the rotation replaced, refused bad_grant', () => {
    const { request } = BAD_GRANT_ROTATED.request_body;
    const at = request.content.gateway_expires_at;
    assert.equal(request.continuation, grantFrom(OLD_ROOT, CONSTANTS.provider.public_key, at));
    assert.notEqual(request.continuation, grantFrom(NEW_ROOT, CONSTANTS.provider.public_key, at));
    assert.deepEqual(Object.keys(BAD_GRANT_ROTATED.response_body).sort(), ['error', 'message']);
    assert.equal(BAD_GRANT_ROTATED.response_body.error, 'bad_grant');
  });
});

describe('a Standby Set rotated under the grant this gateway holds', () => {
  it('resolves to member_unreachable once every member refuses that grant bad_grant', async (t) => {
    const set = await servedSet(t);

    for (const m of set.members) m.rotate(NEW_ROOT);
    await set.nextCadence();
    await set.gateway.untilReason(set.host, 'member_unreachable');

    const answered = await set.gateway.get(set.host);
    assert.equal(answered.status, 503);
    assert.match(answered.json().message, /bad_grant/, 'the tenant is told what the members said');
    // Each member was asked with the grant the OLD root derives for its own
    // key — real values, not two missing ones agreeing.
    assert.equal(set.primary.lastGrant(), grantFrom(OLD_ROOT, PRIMARY.public_key, EXPIRES_AT));
    assert.equal(set.standby.lastGrant(), grantFrom(OLD_ROOT, STANDBY.public_key, EXPIRES_AT));
  });

  it('keeps refusing a handover of the old tokens\' grants, whoever seals it', async (t) => {
    const set = await servedSet(t);
    for (const m of set.members) m.rotate(NEW_ROOT);

    const stale = await set.gateway.handover(handoverFrom(OLD_ROOT));
    assert.equal(stale.status, 403);
    assert.equal(stale.json().error, 'not_admitted', 'a revoked grant cannot re-arm a gateway');
  });

  it('admits a handover of grants from the new tokens through the ordinary round, and replaces what it held', async (t) => {
    const set = await servedSet(t);
    for (const m of set.members) m.rotate(NEW_ROOT);
    await set.nextCadence();
    await set.gateway.untilReason(set.host, 'member_unreachable');

    const asked = set.members.map((m) => m.asked);
    const fresh = await set.gateway.handover(handoverFrom(NEW_ROOT));
    assert.equal(fresh.status, 200, fresh.body);
    assert.equal(fresh.json().workload_id, WORKLOAD);

    // The ordinary admission round: every member asked, each with the grant
    // the NEW root derives for its own key.
    assert.ok(set.members.every((m, i) => m.asked > asked[i]), 'the round asked every member');
    assert.equal(set.primary.lastGrant(), grantFrom(NEW_ROOT, PRIMARY.public_key, EXPIRES_AT));
    assert.equal(set.standby.lastGrant(), grantFrom(NEW_ROOT, STANDBY.public_key, EXPIRES_AT));

    await until(async () => (await set.gateway.get(set.host)).body === 'the primary\'s copy', {
      what: 'the workload to be served again',
    });

    // Replaced, not joined: the next re-ask presents the new grant…
    await set.nextCadence();
    assert.equal(set.primary.lastGrant(), grantFrom(NEW_ROOT, PRIMARY.public_key, EXPIRES_AT));
    assert.equal((await set.gateway.get(set.host)).status, 200);

    // …and the old grant is not one this gateway serves under any more.
    const old = await set.gateway.withdraw(withdrawalFrom(OLD_ROOT));
    assert.equal(old.json().error, 'not_withdrawn');
    assert.equal((await set.gateway.get(set.host)).status, 200);
    const current = await set.gateway.withdraw(withdrawalFrom(NEW_ROOT));
    assert.equal(current.status, 200);
  });
});
