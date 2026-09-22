// Withdrawal: how a tenant takes a workload off this gateway before the grant
// it handed over runs out (spec §12.7).
//
// WHAT MAKES A WITHDRAWAL SAFE WITHOUT A SIGNATURE. Nothing a tenant produces
// is signed any more, so a gateway cannot ask who sent this. It asks something
// else, which is enough: a withdrawal must BEAR THE WORKLOAD'S CURRENT GRANT —
// the value this gateway was handed and is reading the lease with. Only the
// holder of the lease's Continuation Token can derive that value (spec
// §6.5.1), and the only other party holding it is the gateway being withdrawn,
// whose withdrawing itself costs nobody anything. So §12.7's rule survives the
// loss of the signer check: a stranger cannot take any workload off any
// gateway, because a stranger cannot produce the one value that would. A
// withdrawal bearing anything else is IGNORED AND LOGGED, and the workload
// goes on being served.
//
// THE GRANTS ARE COMPARED IN CONSTANT TIME, which is the one comparison here
// that is about a secret. The grant is a secret on the same terms as the token
// it derives from (spec §6.1.1), and a comparison that returned early on the
// first differing byte would let somebody who can send packets learn it a byte
// at a time. Nothing else here is hidden and nothing else pretends to be: that
// this gateway holds a workload at all is plain from asking its hostname
// (§12.3), and which members it holds for one is what the sender named.
//
// A WITHDRAWAL ENDS SERVING, NOT READING. The withdrawn gateway keeps a
// working grant until its `expires_at`, and could still ask a provider for
// `status` with it: a withdrawal revokes nothing. Only the tenant rotating
// the lease's token does (spec §6.8), and that reaches this gateway as
// `bad_grant` from the members, not as a message. What ends, at once, is this
// gateway's SERVING: it stops forwarding the workload, stops following it and
// gives up its readable name. Nothing here says, logs
// or answers that a delegation was revoked, because none was.
//
// IT ASKS NOBODY. No provider is dialled and no relay is read to answer a
// withdrawal — a withdrawal for a workload this gateway does not hold reaches
// nobody at all — so one sealed packet buys no work anywhere else and there is
// nothing here to rate-limit, unlike admission (§12.1).

import { randomUUID, timingSafeEqual } from 'node:crypto';

import { refuse } from './door.mjs';
import { hostnameFor } from './hostname.mjs';
import { readWithdrawal } from './messages.mjs';

/**
 * Whether `withdrawal` bears the grant `held` is being read with, for any
 * member the two have in common.
 *
 * ANY member is enough, and one is all a tenant can be asked for: every value
 * in the set derives from the same root secret (spec §6.5.1), so producing one
 * of them is producing all of them. Requiring the whole set to match would
 * refuse a tenant that withdrew naming the members it still remembers.
 */
function bearsCurrentGrant(held, withdrawal) {
  let matches = 0;
  for (const member of withdrawal.standbySet) {
    const current = held.grantFor(member);
    const borne = withdrawal.grantFor(member);
    // A member this gateway does not hold for the workload carries no grant to
    // compare; it is not a mismatch, and the members it does hold still decide.
    if (current === undefined || borne === undefined) continue;
    // Both are 64 hex characters, checked when they were read, so the two
    // buffers are always 32 bytes and `timingSafeEqual` never throws. Every
    // member named is compared, with no early return on a match either: what
    // must not leak is WHERE two grants differ.
    if (timingSafeEqual(Buffer.from(current, 'hex'), Buffer.from(borne, 'hex'))) matches += 1;
  }
  return matches > 0;
}

/**
 * @param {{
 *   grants: ReturnType<typeof import('./grants.mjs').createHeldGrants>,
 *   onWithdrawn?: () => void,
 *   domain: string,
 *   log?: (line: string) => void,
 * }} deps
 */
export function createWithdrawals({ grants, onWithdrawn = () => {}, domain, log = () => {} }) {
  return {
    /**
     * Withdraw one workload, or ignore the message and say why not.
     *
     * @param {any} body the plaintext `{ "withdrawal": … }` the connector forwarded
     * @returns {{ status: number, body: object }}
     */
    withdraw(body) {
      // Every line below names this withdrawal by a number of this gateway's
      // own, so that two withdrawals naming one workload are tellable apart in
      // a log and nothing a sender chose is what identifies them. The workload
      // id is logged beside it because an operator needs to know what the
      // message was about — as what the sender CLAIMED, which is all it is
      // until a grant is borne for it.
      const attempt = randomUUID().slice(0, 8);

      let withdrawal;
      try {
        withdrawal = readWithdrawal(body);
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        log(`withdrawal ${attempt}: not a withdrawal — ${why}`);
        return refuse(400, 'invalid_withdrawal', why);
      }

      const held = grants.heldFor(withdrawal.workloadId);
      if (held === undefined || !bearsCurrentGrant(held, withdrawal)) {
        // Told apart in the log, where an operator reads it, and NOT in the
        // answer: the two say the same thing to the tenant that sent a
        // withdrawal that did nothing, and the answer is the one a stranger
        // sees too.
        log(
          `withdrawal ${attempt} for workload ${withdrawal.workloadId}: ` +
            (held === undefined
              ? 'this gateway is serving no such workload; ignored, and nobody was asked'
              : 'it does not bear the grant in force here; ignored, and the workload goes on ' +
                'being served'),
        );
        return refuse(
          403,
          'not_withdrawn',
          'this gateway is not serving that workload under the grant this withdrawal bears, so ' +
            'nothing was withdrawn. A withdrawal must bear the grant the gateway holds now, which ' +
            'is the one derived for the moment the handover named. Nobody was asked.',
        );
      }

      // At once, and all three together: this hostname stops being served,
      // this workload stops being followed (`src/follow.mjs`, through
      // `onWithdrawn`), and its readable name is free for another grant.
      grants.release(withdrawal.workloadId);
      onWithdrawn();
      log(
        `withdrawn: workload ${withdrawal.workloadId} is no longer served here. Its grant is ` +
          `untouched and works until ${new Date(held.expiresAt * 1000).toISOString()}`,
      );
      return {
        status: 200,
        body: {
          workload_id: withdrawal.workloadId,
          hostname: hostnameFor(withdrawal.workloadId, domain),
          withdrawn: true,
        },
      };
    },
  };
}
