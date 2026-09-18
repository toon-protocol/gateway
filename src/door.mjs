// The tenant's door: where a sealed message from a tenant arrives, and which
// message it is (spec §12.1, §12.7).
//
// It is its OWN port, not a path on the listeners that front workloads: §12.5
// forbids a gateway requiring anything of the workload, and a reserved path
// would carve a hole out of every tenant's URL space.
//
// ONE DOOR, TWO MESSAGES. A tenant seals both a Gateway Handover and a Gateway
// Withdrawal to the one route this gateway's connector terminates, so both
// arrive here, at the one path that route forwards to. What says which message
// it is, is the body's ONE KEY and nothing else — `handover` or `withdrawal`,
// exactly as a Lease Request's body says `request` (spec §6.1.2). A body that
// is neither is not a message this gateway knows, and is refused as a
// malformed handover rather than guessed at.
//
// NOTHING IS DECIDED HERE. This module reads bytes and routes them: whether a
// handover is admitted is `src/admit.mjs`, and whether a withdrawal bears the
// grant in force is `src/withdraw.mjs`. Both answer in the error shape of §5.

import { HANDOVER_PATH } from './handover.mjs';

/** A refusal, in the error shape of spec §5 — exactly two keys. */
export const refuse = (status, error, message) => ({ status, body: { error, message } });

/**
 * The listener a gateway's connector forwards sealed tenant messages to.
 *
 * @param {{
 *   admission: { admit: (body: any) => Promise<{ status: number, body: object }> },
 *   withdrawals: { withdraw: (body: any) => { status: number, body: object } },
 *   log?: (line: string) => void,
 * }} deps
 */
export function createTenantDoor({ admission, withdrawals, log = () => {} }) {
  /** Nothing sealed to a gateway is large; a bigger body is not a message of this kind. */
  const MAX_BYTES = 64 * 1024;

  /** Which message this body says it is, by its one key. */
  const isWithdrawal = (body) =>
    body !== null &&
    typeof body === 'object' &&
    !Array.isArray(body) &&
    Object.keys(body).length === 1 &&
    Object.keys(body)[0] === 'withdrawal';

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
        answer(
          refuse(
            404,
            'invalid_handover',
            `a Gateway Handover and a Gateway Withdrawal are POSTed to ${HANDOVER_PATH} (spec §12.1, §12.7)`,
          ),
        );
        return;
      }
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null');
      } catch {
        answer(refuse(400, 'invalid_handover', 'the body is not JSON'));
        return;
      }
      // A withdrawal asks nobody anything, so it is answered here and now.
      if (isWithdrawal(body)) {
        answer(withdrawals.withdraw(body));
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
