// A lead-source error that says what kind of problem it is, so the source manager knows
// whether to wait for credits, back off for a rate limit, or stop until settings change.
//   kind: 'credits' — out of credits/quota; resume when they reset (resetAt) or re-check daily
//         'rate'    — too many requests right now; resume after retryAfter seconds
//         'plan'    — this endpoint is not included in the plan; re-check weekly
//         'auth'    — key missing or rejected; wait until the key is changed
//         'other'   — anything else; retry in an hour
export class SourceError extends Error {
  constructor(message, kind = 'other', { retryAfter = null, resetAt = null, status = null } = {}) {
    super(message);
    this.kind = kind;
    this.retryAfter = retryAfter;
    this.resetAt = resetAt;
    this.status = status;
  }
}

/** Classify a failed HTTP response from a lead provider. */
export function classifyHttp(provider, status, message, headers = null) {
  const msg = String(message || '');
  const retry = Number(headers?.get?.('retry-after')) || null;
  if (status === 401) return new SourceError(`${provider} rejected the API key — check it in Integrations`, 'auth', { status });
  if (status === 402 || /credit|quota|usage (limit|exceeded)|exceeded your|insufficient|upgrade your plan to get more/i.test(msg)) {
    return new SourceError(`${provider}: out of credits — waiting until they renew`, 'credits', { status });
  }
  if (status === 429) return new SourceError(`${provider}: rate limit reached — pausing briefly`, 'rate', { retryAfter: retry || 60, status });
  if (status === 403) return new SourceError(`${provider}: your plan does not include this API (${msg.slice(0, 120) || 'forbidden'})`, 'plan', { status });
  return new SourceError(`${provider} error ${status}: ${msg.slice(0, 200)}`, 'other', { status });
}
