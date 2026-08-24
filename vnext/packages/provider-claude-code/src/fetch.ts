// Claude Code terminal HTTP flow for /v1/messages (streaming). Ported from
// copilot-gateway/packages/provider-claude-code/src/fetch.ts.
//
// vNext adaptations vs reference (~469 LOC → ~180 LOC):
//   - Return raw `Response`; provider.ts wraps into `ProviderResponse`.
//   - Fetcher passed directly (no `opts.call.fetcher`).
//   - Background writes go through `waitUntil` from `@vibe-core/platform`;
//     platform bootstrap owns Node vs workerd semantics.
//   - Shaped-passthrough / re-mimicry fork kept: `opts.shaped` selects between
//     the caller's own already-allowlisted fingerprint and our pinned mimicry
//     surface (`pickClaudeCodeHeaders`). See `detection.ts` for the predicate.
//   - Body-sentinel terminal detector (400/403 org-disabled/org-banned)
//     removed. Only OAuth-refresh terminals persist state; upstream 400/403
//     surface verbatim (operator sees Anthropic's own message).
//   - `stream: true` still forced regardless of caller intent — the gateway
//     boundary consumes an SSE envelope.

import {
  ensureClaudeCodeAccessToken,
  invalidateClaudeCodeAccessToken,
  type EnsuredAccessToken,
} from './access-token'
import { ClaudeCodeOAuthSessionTerminatedError } from './auth/oauth'
import type { Fetcher } from './fetcher'
import { pickClaudeCodeHeaders } from './headers'
import type { ClaudeCodeProviderModel } from './models'
import { parseClaudeCodeQuotaHeaders, putClaudeCodeQuota, type ClaudeCodeQuotaSnapshot } from './quota'
import { readClaudeCodeUpstreamState } from './state'
import { getUpstreamRepo } from '@vibe-core/upstream-repo'
import { waitUntil } from '@vibe-core/platform'
import type { MessagesPayload } from '@vibe-llm/protocols/messages'
const ANTHROPIC_MESSAGES_ENDPOINT = 'https://api.anthropic.com/v1/messages?beta=true'

export interface CallClaudeCodeMessagesOptions {
  upstreamId: string
  model: ClaudeCodeProviderModel
  body: Omit<MessagesPayload, 'model'>
  signal?: AbortSignal
  fetcher: Fetcher
  /**
   * True when `isClaudeCodeShapedRequest` recognised the caller as a real
   * Claude Code client. The caller's own already-filtered fingerprint then
   * rides to the wire instead of our pinned mimicry surface, so their genuine
   * session identity survives rather than being replaced by a synthetic one.
   */
  shaped?: boolean
  /** Client headers, pre-filtered by the provider's inbound allowlist. */
  inboundHeaders?: Headers
}

export const callClaudeCodeMessages = async (
  opts: CallClaudeCodeMessagesOptions,
): Promise<Response> => {
  // `opts.model.id` is the public alias on the catalog; the dated upstream id
  // Anthropic expects on the wire — and that the pricing table keys by — rides
  // on `opts.model.providerData.upstreamModelId`.
  const upstreamModelId = opts.model.providerData.upstreamModelId

  const fresh = await getUpstreamRepo().getById(opts.upstreamId)
  if (!fresh) throw new Error(`Claude Code upstream ${opts.upstreamId} disappeared mid-request`)
  const state = readClaudeCodeUpstreamState(fresh.state)
  const account = state.accounts[0]!
  if (account.state !== 'active') {
    return synthetic503(`Claude Code account is ${account.state}: ${account.stateMessage}`)
  }

  const now = new Date()
  const quotaData = account.quotaSnapshot === null ? null : account.quotaSnapshot.data
  if (isRateLimitedNow(quotaData, now)) {
    return synthetic429(
      `Claude Code upstream rate-limited until ${quotaData.reset}`,
      quotaData.reset,
      now,
    )
  }

  const ensured = await ensureOrSession503(opts)
  if (ensured instanceof Response) return ensured

  return await performStreamingMessagesCall(opts, upstreamModelId, ensured, false)
}

// ─── Pre-flight quota gate ─────────────────────────────────────────────────
// `anthropic-ratelimit-unified-status: rejected` paired with a future
// `unified-reset` timestamp means the upstream's primary plan window is
// exhausted and a fresh request would 429 right away; short-circuit at the
// gate so we don't burn an OAuth refresh on a request that has no chance.
//
// Note 1: `overage.status: rejected` (typically paired with
// `overage-disabled-reason: out_of_credits`) is NOT a short-circuit signal.
// It only reports that the account has no extra-usage credits to spill into
// once the primary window runs out — which is the steady state for any
// plan-tier account that hasn't bought extra credits, so blocking on it would
// refuse every request to such accounts. The primary `status` already reflects
// whether the upstream will actually reject the next request.
//
// Note 2: a primary `status: rejected` WITHOUT a `reset` is treated as
// non-gating. Sub2api `ratelimit_service.go:953-961` flags this exact shape as
// "likely not a real rate limit" (e.g. an "Extra usage required" body
// sentinel) and passes it through verbatim — without a reset we'd otherwise
// lock the account out indefinitely because the next request never fires to
// refresh the snapshot.
//
// The `reset > now` clause doubles as the freshness bound: a snapshot whose
// window already elapsed stops gating on its own, so this reads the account
// state already in hand rather than re-reading through the TTL-gated
// `getClaudeCodeQuota`.
const isRateLimitedNow = (
  snapshot: ClaudeCodeQuotaSnapshot | null,
  now: Date,
): snapshot is ClaudeCodeQuotaSnapshot => {
  if (!snapshot) return false
  if (snapshot.status !== 'rejected') return false
  if (!snapshot.reset) return false
  return new Date(snapshot.reset).getTime() > now.getTime()
}

// ─── Pre-fetch access-token gate ───────────────────────────────────────────
// `ensureClaudeCodeAccessToken` internally persists terminal refresh_failed
// state; we just wrap the exception into a 503 for the client.
const ensureOrSession503 = async (
  opts: CallClaudeCodeMessagesOptions,
): Promise<EnsuredAccessToken | Response> => {
  try {
    return await ensureClaudeCodeAccessToken({
      upstreamId: opts.upstreamId,
      fetcher: opts.fetcher,
    })
  } catch (err) {
    if (err instanceof ClaudeCodeOAuthSessionTerminatedError) {
      return synthetic503(`Claude Code refresh failed: ${err.upstreamMessage}`)
    }
    throw err
  }
}

// Shaped path: the gateway already reduced the client's headers to the
// claude-code inbound allowlist, so this preserves that fingerprint as-is and
// only fills Content-Type when the caller omitted it — sub2api does the same on
// its request-forwarding path, so the upstream never receives a body-bearing
// request without a media type.
const passthroughHeaders = (inbound: Headers): Record<string, string> => {
  const out = Object.fromEntries(inbound)
  if (!('content-type' in out)) out['content-type'] = 'application/json'
  return out
}

const performStreamingMessagesCall = async (
  opts: CallClaudeCodeMessagesOptions,
  upstreamModelId: string,
  accessToken: EnsuredAccessToken,
  alreadyRetried: boolean,
): Promise<Response> => {
  const headers: Record<string, string> = {
    ...(opts.shaped && opts.inboundHeaders
      ? passthroughHeaders(opts.inboundHeaders)
      : pickClaudeCodeHeaders(upstreamModelId)),
    // Provider-owned OAuth always wins: the gateway already stripped the
    // client's own authorization, and only this bearer is valid upstream.
    authorization: `Bearer ${accessToken.entry.token}`,
  }

  // Force stream:true regardless of caller intent — the gateway boundary
  // consumes an SSE envelope; non-streaming Messages is routed elsewhere.
  // Safe on the shaped path too: shaped detection requires CC client headers,
  // a CC system block and a valid metadata.user_id, and the real Claude Code
  // client always sets `stream: true`.
  const wireBody = { ...opts.body, model: upstreamModelId, stream: true }

  const response = await opts.fetcher(ANTHROPIC_MESSAGES_ENDPOINT, {
    method: 'POST',
    headers,
    body: JSON.stringify(wireBody),
    signal: opts.signal,
  })

  // Every Anthropic response ships an `anthropic-ratelimit-unified-*` snapshot
  // on 2xx and 429. Other statuses (4xx/5xx outside 429) carry no quota signal.
  if (response.ok || response.status === 429) {
    const snapshot = parseClaudeCodeQuotaHeaders(response.headers)
    if (Object.keys(snapshot.raw).length > 0) {
      waitUntil(putClaudeCodeQuota(opts.upstreamId, snapshot))
    }
  }

  if (
    response.status === 401 &&
    !accessToken.freshlyMinted &&
    !alreadyRetried
  ) {
    // Cached token rejected; invalidate so the next mint reads stale=null,
    // then re-enter with a fresh-minted token. A second 401 means the
    // refresh_token itself is dead — surface the 401 verbatim so the
    // operator sees the real upstream message.
    await invalidateClaudeCodeAccessToken(opts.upstreamId)
    const ensured = await ensureOrSession503(opts)
    if (ensured instanceof Response) return ensured
    return await performStreamingMessagesCall(opts, upstreamModelId, ensured, true)
  }

  return response
}

const synthetic503 = (message: string): Response =>
  new Response(
    JSON.stringify({ error: { type: 'claude_code_upstream_unavailable', message } }),
    { status: 503, headers: { 'content-type': 'application/json' } },
  )

const synthetic429 = (message: string, retryAtIso: string | null, now: Date): Response => {
  const retryAfterSeconds =
    retryAtIso === null
      ? 60
      : Math.max(0, Math.ceil((new Date(retryAtIso).getTime() - now.getTime()) / 1000))
  return new Response(
    JSON.stringify({ error: { type: 'claude_code_rate_limited', message, retry_at: retryAtIso } }),
    {
      status: 429,
      headers: { 'content-type': 'application/json', 'retry-after': String(retryAfterSeconds) },
    },
  )
}
