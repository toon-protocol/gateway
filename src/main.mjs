// The Workload Gateway process (ADR 0013, spec §12).
//
// It reads its configuration out of the environment, refuses to start if any
// of it is missing, and then serves every workload a tenant has granted it —
// finding those grants itself, on the relays it watches.
//
// It holds no lease, pays for nothing and calls no paid route: its whole
// authority is the Gateway Grant, and reading a relay is free.

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

log(`this gateway is ${config.publicKey}`);
log(`name a workload's Gateway Grant at this key to have it served under *.${config.domain}`);
log(`watching ${config.relays.length} relay(s) for grants: ${config.relays.join(', ')}`);
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
