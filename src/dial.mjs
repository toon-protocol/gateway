// How this gateway opens a TCP connection, and the one host it refuses to.
//
// Every outbound connection a gateway makes — asking a member for `status`,
// and forwarding a tenant's request to the workload — goes through ONE seam:
// `connect(host, port)` returns a socket to use, or `undefined` meaning "an
// ordinary direct dial". Both legs share it on purpose, because both legs can
// land on a Hidden Provider (spec §10) and a gateway that got one right and
// the other wrong would leak exactly what hiding is for.
//
// M5-6 is what fills the `.anyone` case in: a per-lease `.anyone` address is
// dialled through the configured `socks5h://` proxy, and the gateway is an
// ordinary client of it. Until then this module's whole job is to make sure
// such a name is never dialled the WRONG way: an `.anyone` host has no meaning
// to a system resolver, and handing one to `getaddrinfo` would put a hidden
// service into a plaintext DNS query. So it is refused, loudly, rather than
// attempted.

/** Whether a host is an `.anyone` address, which is never dialled directly. */
export const isAnyoneHost = (host) =>
  typeof host === 'string' && /\.anyone\.?$/i.test(host.replace(/^\[|\]$/g, ''));

/**
 * The dialler this gateway uses.
 *
 * @param {{ socksProxy?: string }} [options]
 * @returns {{ connect: (host: string, port: number) => import('node:net').Socket | undefined }}
 */
export function createDialer({ socksProxy } = {}) {
  return {
    connect(host, port) {
      if (isAnyoneHost(host)) {
        // M5-6 dials this through `socksProxy`. Throwing is what keeps the
        // promise in the meantime: the caller answers `member_unreachable`,
        // and no resolver ever saw the name.
        throw new Error(
          `${host}:${port} is an \`.anyone\` address and this gateway cannot dial one yet: ` +
            'it is never resolved or dialled directly (spec §10). Reaching one through ' +
            `TOON_SOCKS_PROXY${socksProxy === undefined ? ' (unset)' : ''} is M5-6.`,
        );
      }
      return undefined;
    },
  };
}
