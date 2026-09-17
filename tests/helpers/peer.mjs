// Who connected to a stub: the gateway itself, or a proxy on its behalf.
//
// Every stub records this beside what it received, so a test can say not
// only that a request arrived but where the connection came from — which is
// how "it went through the proxy" becomes a positive fact (M5-6).

/** The far end of a request's connection, as `{ address, port }`. */
export const peerOf = (req) => ({
  address: String(req.socket.remoteAddress ?? '').replace(/^::ffff:/i, ''),
  port: req.socket.remotePort ?? 0,
});
