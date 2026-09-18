// Finding where a granted workload is running, and sending the tenant there.
//
// RESOLUTION FOLLOWS THE GRANT AND NOTHING ELSE (spec §12). The handover that
// brought the grant names the Standby Set; each member's Provider Profile says
// where its connector is; every member is asked for `status` with the grant
// presented as the request's `continuation`; the member answering `running`
// with `access` is the one running the workload. Members are asked in parallel
// because a Standby Set is several providers and a slow one must not hold up
// the others, and the answer is taken in `standby_set` order — primary first —
// so a Takeover that has settled in two places at once still resolves the same
// way everywhere.
//
// A member that answers `reserved`, `stopped` or an ending is simply not the
// target: that is a Warm Standby doing its job (spec §6.7), not a failure.
//
// What a member TOLD US is the distinction that matters, and it is not the
// same as whether it answered at all. `reserved` tells us the member is not
// running the workload. A connector that never replied tells us nothing. And
// neither does a REFUSAL — `bad_grant` on an expired grant, `unknown_workload`
// from a member that never held the lease — even though it arrived as an HTTP
// response. Refusals are therefore counted with silence, because saying "no
// member is running it" on the strength of a `bad_grant` would tell a tenant a
// fact about its lease that this gateway never learned.
//
// WHAT M5-5 TAKES OVER FROM HERE. The current target per workload lives in
// `targets` and nowhere else; `resolveNow` is the one way a resolution is
// started, and it collapses concurrent callers onto one attempt; `targetFor`
// answers from `targets` without asking anybody when a target is already
// known, which is already the "last known target keeps serving" rule — what
// M5-5 adds is a reason to re-ask (a Takeover, a cadence, an expiry) rather
// than a different way to ask.

import { Agent } from 'node:http';

import { refusalFor } from './dial.mjs';
import { forwardRequest, forwardUpgrade } from './forward.mjs';
import { unavailable } from './reasons.mjs';
import { askStatus, statusRequest } from './status.mjs';

/**
 * How long resolution waits for anything: a member's Profile off a relay, and
 * that member's answer to `status`. One number rather than two, because what
 * an operator is actually setting is how long a tenant waits for a first
 * request while this gateway finds out where the workload is.
 */
export const RESOLVE_TIMEOUT_MS = 3000;

/**
 * The host port a granted `http_port` was published at.
 *
 * `http_port` is the CONTAINER port the spawn asked for (spec §12.1); the
 * host port is the provider's to choose and comes back in `access`. Neither
 * the first port nor the SSH port is it, and guessing either would put a
 * tenant's traffic into whatever else the workload exposes.
 */
export function hostPortFor(access, httpPort) {
  if (!Array.isArray(access?.ports)) return undefined;
  const published = access.ports.find(
    (entry) => entry !== null && typeof entry === 'object' && entry.container_port === httpPort,
  );
  const port = published?.host_port;
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined;
}

/**
 * @param {{
 *   profiles: ReturnType<typeof import('./profiles.mjs').createProfiles>,
 *   dialer?: { connect: import('./dial.mjs').Dial },
 *   now?: () => number,
 *   log?: (line: string) => void,
 *   timeoutMs?: number,
 * }} deps
 */
export function createResolver({
  profiles,
  dialer,
  now = () => Math.floor(Date.now() / 1000),
  log = () => {},
  timeoutMs = RESOLVE_TIMEOUT_MS,
}) {
  /** Where each workload is running, as far as this gateway knows. */
  /** @type {Map<string, { host: string, port: number, member: string, at: number }>} */
  const targets = new Map();
  /** One resolution per workload at a time; concurrent requests join it. */
  /** @type {Map<string, Promise<any>>} */
  const inFlight = new Map();

  const connect = dialer?.connect;
  // The gateway's own keep-alive pool for forwarded requests, so a busy
  // workload is not a new TCP connection per request and `close()` still
  // leaves nothing open. Node's global agent would survive a shutdown.
  const agent = new Agent({ keepAlive: true });

  /**
   * Ask ONE member where the workload is.
   *
   * `told` is whether the member told us about the LEASE — not whether it
   * answered. A refusal is an HTTP response and tells us nothing.
   *
   * `refusal` is the one case that is neither: a member THIS GATEWAY would not
   * dial — an `.anyone` connector with no proxy configured (spec §12.8). That
   * is a fact about this gateway's configuration, and the tenant is told it
   * by name rather than as one more member that could not be reached.
   *
   * @returns {Promise<
   *   { told: true, target?: object } |
   *   { told: false, why: string, refusal?: ReturnType<typeof unavailable> }
   * >}
   */
  const askMember = async (grant, member) => {
    const profile = profiles.get(member);
    if (profile === undefined) {
      return {
        told: false,
        why: `${member}: no Provider Profile for it was found on any relay watched`,
      };
    }

    let answered;
    try {
      answered = await askStatus({
        connectorUrl: profile.connectorUrl,
        request: statusRequest({
          member,
          workloadId: grant.workloadId,
          grant: grant.grantFor(member),
          gatewayExpiresAt: grant.expiresAt,
          now: now(),
        }),
        timeoutMs,
        connect,
      });
    } catch (e) {
      return {
        told: false,
        why: `${profile.connectorUrl}: ${e instanceof Error ? e.message : String(e)}`,
        refusal: refusalFor(e, grant.workloadId),
      };
    }

    const body = answered.body;
    // A refusal is not an answer about the lease: it says this gateway may not
    // read it, or that this member never held it. Either way nothing was
    // learned about whether the workload is running here.
    if (body?.error !== undefined) {
      return { told: false, why: `${profile.connectorUrl}: refused \`status\` (${body.error})` };
    }
    if (body?.state !== 'running') return { told: true };
    if (typeof body.access?.host !== 'string' || body.access.host === '') {
      log(`member ${member} answers \`running\` for ${grant.workloadId} with no \`access.host\``);
      return { told: true };
    }
    const port = hostPortFor(body.access, grant.httpPort);
    if (port === undefined) {
      log(
        `member ${member} answers \`running\` for ${grant.workloadId} but publishes no host port ` +
          `for the grant's \`http_port\` ${grant.httpPort}`,
      );
      return { told: true };
    }
    return { told: true, target: { host: body.access.host, port, member, at: now() } };
  };

  /**
   * ONE BOUNDED ROUND: every member is sent `status`, all of them and at once.
   *
   * It records nothing. `told` is how many members answered ABOUT THE LEASE,
   * which is both what §12.4 resolves on and what admission proves a grant
   * with (`src/admit.mjs`): a member that takes the grant is a member only the
   * holder of the lease's Continuation Token could have produced one for.
   *
   * @returns {Promise<{ told: number, target?: any, unavailable?: ReturnType<typeof unavailable> }>}
   */
  const askMembers = async (grant) => {
    const members = grant.standbySet;
    profiles.watch(members);
    await profiles.waitFor(members, { timeoutMs });

    const answers = await Promise.all(members.map((member) => askMember(grant, member)));
    const silent = answers.filter((answer) => !answer.told);
    const told = answers.length - silent.length;

    // `standby_set` order, primary first: whichever members happened to answer
    // first, the same Standby Set resolves the same way on every gateway.
    const found = answers.find((answer) => answer.told && answer.target !== undefined);
    if (found?.target !== undefined) return { told, target: found.target };

    // A member this gateway would not even dial is answered by name: no
    // proxy is something the operator fixes, and `member_unreachable` would
    // send them looking at the member.
    const notDialled = silent.find((answer) => answer.refusal !== undefined);
    if (notDialled?.refusal !== undefined) {
      log(`workload ${grant.workloadId}: ${notDialled.why}`);
      return { told, unavailable: notDialled.refusal };
    }
    if (silent.length === 0) {
      return {
        told,
        unavailable: unavailable('no_running_member', {
          workloadId: grant.workloadId,
          members: members.length,
        }),
      };
    }
    const why = silent.map((answer) => answer.why).join('; ');
    log(
      `workload ${grant.workloadId}: ${silent.length} of ${members.length} member(s) told this ` +
        `gateway nothing about the lease: ${why}`,
    );
    return {
      told,
      unavailable: unavailable('member_unreachable', { workloadId: grant.workloadId, why }),
    };
  };

  /** Ask every member, and take the first that is running, remembering it. */
  const ask = async (grant) => {
    const round = await askMembers(grant);
    if (round.target !== undefined) {
      const target = round.target;
      const held = targets.get(grant.workloadId);
      if (held?.host !== target.host || held?.port !== target.port) {
        log(
          `workload ${grant.workloadId} is running at ${target.host}:${target.port} ` +
            `on member ${target.member}`,
        );
      }
      targets.set(grant.workloadId, target);
      return { target };
    }
    targets.delete(grant.workloadId);
    return { unavailable: round.unavailable };
  };

  /** Start a resolution, or join the one already running for this workload. */
  const resolveNow = (grant) => {
    const running = inFlight.get(grant.workloadId);
    if (running !== undefined) return running;
    const attempt = ask(grant).finally(() => inFlight.delete(grant.workloadId));
    inFlight.set(grant.workloadId, attempt);
    return attempt;
  };

  /** Where to send a request now: what is known, or a resolution. */
  const targetFor = (grant) => {
    const held = targets.get(grant.workloadId);
    return held === undefined ? resolveNow(grant) : Promise.resolve({ target: held });
  };

  /** @type {import('./serve.mjs').Resolver} */
  const resolve = async ({ grant, req, res, socket, head, secure }) => {
    const found = await targetFor(grant);
    if (found.unavailable !== undefined) return found;
    const target = found.target;
    const forwarded =
      res === undefined
        ? await forwardUpgrade({ req, socket, head, target, workloadId: grant.workloadId, secure, connect })
        : await forwardRequest({ req, res, target, workloadId: grant.workloadId, secure, connect, agent });

    // The address we believed in did not answer. Forget it, so the next
    // request asks the Standby Set again instead of retrying a dead host.
    if (forwarded?.unavailable !== undefined && targets.get(grant.workloadId) === target) {
      targets.delete(grant.workloadId);
    }
    return forwarded;
  };

  return {
    /** The resolver `startGateway` runs with. */
    resolve,
    /** Ask the Standby Set again, now (M5-5's Takeover and cadence hook). */
    resolveNow,
    /**
     * The admission round of §12.1: one round, recording nothing.
     *
     * It deliberately does NOT join `resolveNow`'s in-flight attempt and does
     * not touch `targets`. A handover this gateway has not accepted must not
     * be able to ride on a round started for the grant it holds, nor drop the
     * target of a workload already being served by failing.
     */
    probe: askMembers,
    /** Serve a workload at a target the admission round already found. */
    remember: (workloadId, target) => targets.set(workloadId, target),
    /** Where a workload is running, as far as this gateway knows. */
    current: (workloadId) => targets.get(workloadId),
    /** Stop serving a workload's last known target (M5-5: a grant that ran out). */
    forget: (workloadId) => targets.delete(workloadId),
    close() {
      targets.clear();
      inFlight.clear();
      agent.destroy();
    },
  };
}
