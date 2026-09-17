// Why a workload is not being served, in words (spec §12).
//
// A tenant whose URL stopped working needs to tell a stopped workload from an
// expired grant from a broken gateway, and none of those is visible from a
// closed connection or a bare 503. So every refusal this gateway makes names
// a reason from ONE vocabulary, and the vocabulary lives in one table.
//
// EXTENDING IT: add a row to `REASONS` below (or call `defineReason` from the
// module that raises it) and nothing else changes — the HTTP status, the JSON
// shape, the HTML page and the header are all derived from the row. M5-4 adds
// `no_running_member` and `member_unreachable`; M5-6 adds the missing proxy.
//
// A row is `code -> (context) => message`. The context is whatever the caller
// knows; a message that names the hostname or the workload id is worth far
// more to the person reading it than one that does not.

/** The whole vocabulary. Every 503 this gateway answers is one of these. */
export const REASONS = {
  no_grant: ({ host }) =>
    `no grant for this hostname: ${host} names no workload this gateway has been granted. ` +
    'A Gateway Grant naming this gateway (spec §3.1.3) is how a workload arrives here.',

  grant_expired: ({ workloadId, expiresAt }) =>
    `the grant expired: the Gateway Grant for workload ${workloadId} ran out at ` +
    `${new Date(expiresAt * 1000).toISOString()}. Publishing the grant again under the same ` +
    'workload id renews it (spec §3.1.3); this gateway then serves it again with no restart.',

  not_resolved: ({ workloadId }) =>
    `not resolved yet: this gateway holds a grant for workload ${workloadId} but has not yet ` +
    'found which member of its Standby Set is running it.',
};

/**
 * Add a reason to the vocabulary.
 *
 * Refuses to redefine one: two tickets that pick the same code would otherwise
 * silently reword each other's refusals, and a reason is part of what a tenant
 * reads.
 */
export function defineReason(code, message) {
  if (Object.hasOwn(REASONS, code)) {
    throw new Error(`the reason "${code}" is already in the vocabulary (src/reasons.mjs)`);
  }
  REASONS[code] = message;
  return code;
}

/**
 * One refusal: `{ reason, status, message }`.
 *
 * An unknown code throws rather than rendering an empty page, so a typo is a
 * failing test here and never a blank 503 in front of a tenant.
 */
export function unavailable(code, context = {}) {
  const message = REASONS[code];
  if (message === undefined) {
    throw new Error(
      `"${code}" is not a gateway reason: add it to REASONS in src/reasons.mjs first`,
    );
  }
  return { reason: code, status: 503, message: message(context) };
}

const escapeHtml = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

/**
 * The bytes of a refusal: JSON by default, a readable page for a browser.
 *
 * The JSON is `{ "error", "message" }` — exactly the shape every provider
 * route answers a refusal in (spec §5), so a tenant's tooling parses a gateway
 * refusal with the code it already has.
 */
export function renderUnavailable(why, accept = '*/*') {
  if (typeof accept === 'string' && accept.includes('text/html')) {
    return {
      status: why.status,
      contentType: 'text/html; charset=utf-8',
      body:
        '<!doctype html>\n<html lang="en"><head><meta charset="utf-8">' +
        `<title>503 ${escapeHtml(why.reason)}</title>` +
        '<style>body{font:16px/1.5 system-ui,sans-serif;margin:8vh auto;max-width:40rem;padding:0 1rem}' +
        'code{background:#eee;padding:.1em .3em;border-radius:.2em}</style></head><body>' +
        '<h1>503 &mdash; this workload is not being served</h1>' +
        `<p><code>${escapeHtml(why.reason)}</code></p>` +
        `<p>${escapeHtml(why.message)}</p>` +
        '<p><small>This is the Workload Gateway answering, not the workload ' +
        '(TOON Network spec §12).</small></p></body></html>\n',
    };
  }
  return {
    status: why.status,
    contentType: 'application/json; charset=utf-8',
    body: `${JSON.stringify({ error: why.reason, message: why.message })}\n`,
  };
}
