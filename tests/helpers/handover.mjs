// The tenant's side of a Gateway Handover, as much of it as a test needs.
//
// A gateway never derives a grant — the tenant does, from the lease's root
// secret (spec §6.5.1), and the tool that does it is TOON_Network#59. What is
// here is the same two HKDFs, so that a test hands the gateway a value a real
// provider would accept, and a stub member can check one the way a provider
// checks it. `tests/derivation.test.mjs` pins both against the provider's own
// `gateway_sub.vector` fixture, so a disagreement is a failing test here.

import { hkdfSync } from 'node:crypto';

import { CONSTANTS } from './events.mjs';
import { refusal } from './stub-connector.mjs';

const hkdf = (ikm, info) =>
  Buffer.from(hkdfSync('sha256', Buffer.from(ikm, 'hex'), Buffer.alloc(0), Buffer.from(info, 'ascii'), 32)).toString('hex');

/** `continuation(provider)` (spec §6.1.1). */
export const continuationFor = (rootSecret, providerPubkey) =>
  hkdf(rootSecret, `toon-network-continuation:${providerPubkey.toLowerCase()}`);

/** `gateway_sub(provider, expires_at)` (spec §6.5.1). */
export const gatewaySub = (continuation, expiresAt) =>
  hkdf(continuation, `toon-network-gateway:${expiresAt}`);

/** The grant a lease's root secret derives for one provider and one moment. */
export const grantFrom = (rootSecret, providerPubkey, expiresAt) =>
  gatewaySub(continuationFor(rootSecret, providerPubkey), expiresAt);

/**
 * The body of a Gateway Handover: `{ "handover": … }` and nothing else.
 *
 * `standbySet` is the members in `standby_set` order, primary first. Each gets
 * the grant the lease's root secret derives FOR ITS OWN KEY — one value per
 * member, because that is what §6.5.1's derivation makes.
 *
 * @param {{
 *   workloadId: string, standbySet?: string[], httpPort?: any,
 *   expiresAt?: any, name?: any, rootSecret?: string,
 *   grantFor?: (member: string) => any, members?: any,
 * }} options
 */
export function gatewayHandover({
  workloadId,
  standbySet = [CONSTANTS.provider.public_key],
  httpPort = 8080,
  expiresAt = CONSTANTS.now + 86_400,
  name,
  rootSecret = CONSTANTS.tenant.root_secret,
  grantFor = (member) => grantFrom(rootSecret, member, expiresAt),
  members,
}) {
  const handover = {
    workload_id: workloadId,
    standby_set:
      members ?? standbySet.map((member) => ({ provider: member, grant: grantFor(member) })),
    http_port: httpPort,
    expires_at: expiresAt,
  };
  if (name !== undefined) handover.name = name;
  return { handover };
}

/**
 * A member that really holds this lease, checking a presented grant the way
 * spec §6.5.1 has a provider check one.
 *
 * This is what makes admission EMPIRICAL rather than agreed: the stub takes
 * only the value the lease's own token derives for its own key at the moment
 * the request asserts, so a handover a test made up is refused exactly where a
 * real provider would refuse it, with `bad_grant` and nothing else.
 *
 * @param {{
 *   member: string, workloadId: string, rootSecret?: string,
 *   now?: () => number, answer: (context: any) => object,
 * }} options
 */
export function asProvider({
  member,
  workloadId,
  rootSecret = CONSTANTS.tenant.root_secret,
  now = () => CONSTANTS.now,
  answer,
}) {
  const continuation = continuationFor(rootSecret, member);
  return (context) => {
    if (context.workloadId !== workloadId) {
      return refusal('unknown_workload', 'this provider never leased that workload id');
    }
    const at = context.gatewayExpiresAt;
    if (!Number.isInteger(at) || now() > at || context.continuation !== gatewaySub(continuation, at)) {
      return refusal(
        'bad_grant',
        'this delegation does not apply here; ask the tenant for one derived for this workload ' +
          'and this moment',
      );
    }
    return answer(context);
  };
}
