// The Workload Gateway process (ADR 0013, spec §12).
//
// It reads its configuration out of the environment, refuses to start if any
// of it is missing, and then serves every workload a tenant has handed over to
// it — admitting each one by asking the members whether the grant works.
//
// It holds no lease, pays for nothing and calls no paid route; it signs
// nothing and publishes nothing. Its whole authority is a Gateway Grant, and
// a grant reaches it in one sealed packet (spec §12.1).

import { readConfig } from './config.mjs';
import { startGateway } from './gateway.mjs';

const log = (line) => console.log(`[gateway] ${line}`);

let config;
try {
  config = readConfig(process.env);
} catch (e) {
  console.error(`[gateway] ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}

const gateway = await startGateway({ config, log });

log(`seal a Gateway Handover to this gateway's connector to have a workload served under *.${config.domain}`);
log(`watching ${config.relays.length} relay(s) for Provider Profiles and Takeovers: ${config.relays.join(', ')}`);
log(`admission asks any one provider at most ${config.admitPerMinute} time(s) a minute`);
if (config.socksProxy !== undefined) log(`.anyone hosts will be dialled through ${config.socksProxy}`);
for (const [from, to] of config.dialRewrites) {
  log(`dial rewrite: ${from} is dialled at ${to.host}${to.port === undefined ? '' : `:${to.port}`} (GATEWAY_DIAL_REWRITE)`);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    log(`${signal}: shutting down`);
    gateway.stop().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}
