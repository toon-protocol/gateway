// Admission: how a gateway decides to serve a workload it was sent (spec
// §12.1).
//
// A gateway can no longer check a handover against a signature, so it checks
// it EMPIRICALLY: it sends `status` to the members the handover names and sees
// whether they take the grant. Being sent something becomes proof precisely
// because only the holder of the lease's Continuation Token can derive a grant
// a member will accept (spec §6.5.1) — a stranger can seal a packet, and what
// it cannot do is make a provider answer one.
//
// ONE BOUNDED ROUND, IMMEDIATELY, AND NO RETRY. The round is `src/resolve.mjs`
// asking every member at once, bounded by the same resolve timeout a tenant's
// first request is bounded by. A handover the members refuse is logged, the
// sender is told, and it is DROPPED: nothing queues it, nothing tries it
// later, and nothing about this gateway changed. A tenant whose handover
// failed sends another one, which is one packet and costs it nothing.
//
// AMPLIFICATION, and why the rate limit is not optional. Anyone can seal a
// handover naming any provider, so one sealed packet a stranger paid to
// deliver buys one free `status` to each member it names: the ratio is about
// one to one, and it is bounded above by `MAX_STANDBY_SET`. That makes this
// gateway a small reflector unless admission is rate-limited PER MEMBER, which
// is what the buckets below are: a burst of unsolicited handovers naming one
// provider cannot make this gateway exceed that provider's rate, however the
// burst is spread across workloads or senders.
//
// A GATEWAY CANNOT ALLOWLIST TENANTS, and that is a consequence of the design
// rather than a gap here. After Milestone 6 there is no tenant identity to put
// on a list: nothing is signed, nothing is published, and the sealed envelope
// is unauthenticated on purpose (ADR 0011, connector ADR 0018). What a gateway
// can bound is the work one packet buys, which is all the code below does.

import { randomUUID } from 'node:crypto';

import { hostnameFor } from './hostname.mjs';
import { HANDOVER_PATH, readHandover } from './handover.mjs';

/** How many admission rounds one member may be asked for in a minute. */
export const ADMIT_PER_MINUTE = 6;

const MINUTE_MS = 60_000;

/**
 * A token bucket per member, refilling continuously.
 *
 * Per MEMBER and not per sender, because there is no sender to count: a
 * handover names nobody and is sealed in an envelope that authenticates
 * nobody. What must be bounded is the load this gateway can be made to put on
 * one provider, and that is exactly what a member's own bucket bounds.
 *
 * @param {{ perMinute?: number, clock?: () => number }} [options]
 */
export function createAdmissionRate({ perMinute = ADMIT_PER_MINUTE, clock = () => Date.now() } = {}) {
  /** @type {Map<string, { tokens: number, at: number }>} */
  const buckets = new Map();

  const peek = (member) => {
    const at = clock();
    const bucket = buckets.get(member) ?? { tokens: perMinute, at };
    const refilled = Math.min(perMinute, bucket.tokens + ((at - bucket.at) * perMinute) / MINUTE_MS);
    return { tokens: refilled, at };
  };

  return {
    /**
     * Take one token from every member, or from none of them.
     *
     * All or nothing on purpose: a handover naming a member that is over its
     * rate is refused whole, so a burst cannot walk through a Standby Set
     * spending the members that are still under it.
     */
    take(members) {
      const peeked = members.map((member) => /** @type {const} */ ([member, peek(member)]));
      const over = peeked.find(([, bucket]) => bucket.tokens < 1);
      if (over !== undefined) return { taken: false, member: over[0] };
      for (const [member, bucket] of peeked) {
        buckets.set(member, { tokens: bucket.tokens - 1, at: bucket.at });
      }
      return { taken: true };
    },
  };
}

/** A refusal, in the error shape of spec §5 — exactly two keys. */
const refuse = (status, error, message) => ({ status, body: { error, message } });

/**
 * The gateway's admission door.
 *
 * @param {{
 *   grants: ReturnType<typeof import('./grants.mjs').createHeldGrants>,
 *   probe: (handover: any) => Promise<{ told: number, target?: any, unavailable?: any }>,
 *   remember?: (workloadId: string, target: any) => void,
 *   onSettled?: () => void,
 *   domain: string,
 *   now?: () => number,
 *   log?: (line: string) => void,
 *   rate?: ReturnType<typeof createAdmissionRate>,
 * }} deps
 */
export function createAdmission({
  grants,
  probe,
  remember = () => {},
  onSettled = () => {},
  domain,
  now = () => Math.floor(Date.now() / 1000),
  log = () => {},
  rate = createAdmissionRate(),
}) {
  return {
    /**
     * Admit one sealed handover, or refuse it and forget it.
     *
     * @param {any} body the plaintext `{ "handover": … }` the connector forwarded
     * @returns {Promise<{ status: number, body: object }>}
     */
    async admit(body) {
      // Every refusal below names the handover by a number of this gateway's
      // own, never by anything the sender chose: a workload id in a log line
      // is a workload id a stranger can put there.
      const attempt = randomUUID().slice(0, 8);

      let handover;
      try {
        handover = readHandover(body);
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        log(`handover ${attempt}: not a handover — ${why}`);
        return refuse(400, 'invalid_handover', why);
      }

      // Before anything is sent: a gateway MUST NOT carry an expired grant to
      // a provider (spec §12.7), and a handover that arrives already out of
      // force could never put the workload anywhere.
      if (!handover.inForceAt(now())) {
        log(
          `handover ${attempt} for workload ${handover.workloadId}: its grant expired at ` +
            `${new Date(handover.expiresAt * 1000).toISOString()}; nothing was asked`,
        );
        return refuse(
          403,
          'grant_expired',
          'that grant was derived for a moment that has passed, so no member would take it and ' +
            'nothing was asked. Derive one for a later moment and hand it over again.',
        );
      }

      const allowed = rate.take(handover.standbySet);
      if (!allowed.taken) {
        log(
          `handover ${attempt} for workload ${handover.workloadId}: admission for member ` +
            `${allowed.member} is over its rate; nothing was asked`,
        );
        return refuse(
          429,
          'rate_limited',
          'this gateway bounds how often it will ask any one provider to admit a handover, ' +
            'because anyone can seal one. Nothing was asked; try again shortly.',
        );
      }

      // Every path below this point has already asked somebody, so every one
      // of them settles: an accepted handover starts being followed, and a
      // refused one has its members let go of rather than left in the Profile
      // filter this gateway watches (spec §12.1: a dropped handover is not
      // remembered).
      const round = await probe(handover).finally(() => onSettled());
      if (round.told === 0) {
        // A member this gateway would not even DIAL is a fact about this
        // gateway's configuration and not about the grant (spec §12.8). §12.3
        // keeps `no_proxy` apart from every other reason for exactly that, and
        // it is not collapsed into `not_admitted` at this door either.
        if (round.unavailable?.reason === 'no_proxy') {
          log(
            `handover ${attempt} for workload ${handover.workloadId}: a member of its Standby Set ` +
              'is at an `.anyone` address this gateway has no proxy for; dropped',
          );
          return refuse(503, 'no_proxy', round.unavailable.message);
        }
        // Dropped, and never retried. Nothing here remembers the handover, so
        // there is nothing to retry with and nothing a burst can accumulate.
        log(
          `handover ${attempt} for workload ${handover.workloadId}: no member of its Standby Set ` +
            'took the grant; dropped',
        );
        return refuse(
          403,
          'not_admitted',
          'no member of the Standby Set this handover names accepted its grant, so this gateway ' +
            'has no authority to read that lease and is serving nothing. The handover was ' +
            'dropped; it is not retried.',
        );
      }

      grants.hold(handover);
      if (round.target !== undefined) remember(handover.workloadId, round.target);
      onSettled();
      return {
        status: 200,
        body: {
          workload_id: handover.workloadId,
          hostname: hostnameFor(handover.workloadId, domain),
          expires_at: handover.expiresAt,
        },
      };
    },
  };
}

/**
 * The listener a gateway's connector forwards sealed handovers to.
 *
 * It is its OWN port, not a path on the listeners that front workloads: §12.5
 * forbids a gateway requiring anything of the workload, and a reserved path
 * would carve a hole out of every tenant's URL space.
 *
 * @param {{ admission: { admit: (body: any) => Promise<{ status: number, body: object }> }, log?: (line: string) => void }} deps
 */
export function createHandoverHandler({ admission, log = () => {} }) {
  /** Nothing sealed to a gateway is large; a bigger body is not a handover. */
  const MAX_BYTES = 64 * 1024;

  return (req, res) => {
    const answer = ({ status, body }) => {
      const payload = `${JSON.stringify(body)}\n`;
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': String(Buffer.byteLength(payload)),
      });
      res.end(payload);
    };

    // The body is read to its end BEFORE anything is answered, refusals
    // included: a response written over a request still arriving is a
    // connection Node closes under us, and the sender would see a hang-up
    // where it should see a refusal it can act on.
    /** @type {Buffer[]} */
    const chunks = [];
    let bytes = 0;
    let stopped = false;
    req.on('data', (chunk) => {
      if (stopped) return;
      bytes += chunk.length;
      if (bytes > MAX_BYTES) {
        stopped = true;
        answer(refuse(413, 'invalid_handover', 'that is far too large to be a handover'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (stopped) return;
      if (req.method !== 'POST' || (req.url ?? '').split('?')[0] !== HANDOVER_PATH) {
        answer(refuse(404, 'invalid_handover', `a Gateway Handover is POSTed to ${HANDOVER_PATH} (spec §12.1)`));
        return;
      }
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null');
      } catch {
        answer(refuse(400, 'invalid_handover', 'the body is not JSON'));
        return;
      }
      admission.admit(body).then(answer, (e) => {
        // NOT `not_admitted`: that says the members refused the grant, and
        // here nobody finished being asked. A gateway fault is the gateway's
        // to own, and a tenant that is told the wrong one would go and derive
        // a grant that was never the problem.
        log(`admitting a handover threw: ${e instanceof Error ? e.stack : String(e)}`);
        answer(
          refuse(
            503,
            'admission_failed',
            'this gateway could not carry out an admission round just now; nothing was decided ' +
              'about the grant. Try again.',
          ),
        );
      });
    });
  };
}
