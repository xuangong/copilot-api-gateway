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
  refreshClaudeCodeAccessTokenForRetry,
  ClaudeCodeCredentialUnavailableError,
  type EnsuredAccessToken,
} from './access-token'
import { ClaudeCodeOAuthSessionTerminatedError } from './auth/oauth'
import type { Fetcher } from './fetcher'
import { pickClaudeCodeHeaders } from './headers'
import type { ClaudeCodeProviderModel } from './models'
import { parseClaudeCodeQuotaHeaders, putClaudeCodeQuota, type ClaudeCodeQuotaSnapshot } from './quota'
import { readClaudeCodeCredential, type ClaudeCodeCredentialSnapshot, type ClaudeCodeCredentialTarget } from './credential-effects'
import { assertClaudeCodeExecutionAuthority, claudeCodeAffinityTarget, ClaudeCodeAffinityChangedError, type ClaudeCodeExecutionAuthority } from './affinity-execution'
import { waitUntil } from '@vibe-core/platform'
import type { MessagesPayload } from '@vibe-llm/protocols/messages'
import type { ProviderRequest, ProviderResponse } from '@vibe-llm/provider-llm'
const ANTHROPIC_MESSAGES_ENDPOINT = 'https://api.anthropic.com/v1/messages?beta=true'

export interface CallClaudeCodeMessagesOptions {
  upstreamId: string
  expected: ClaudeCodeExecutionAuthority
  model: ClaudeCodeProviderModel
  body: Omit<MessagesPayload, 'model'>
  signal?: AbortSignal
  fetcher: Fetcher
  executionFetcher?: Fetcher
  beforeInference?: ProviderRequest['beforeInference']
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

export interface ClaudeCodePreparedCallResult {
  response: Response
  affinityExecution?: ProviderResponse['affinityExecution']
  execution?: ProviderResponse['execution']
}

export const callClaudeCodeMessages = async (
  opts: CallClaudeCodeMessagesOptions,
): Promise<Response> => (await callClaudeCodeMessagesPrepared(opts)).response

export const callClaudeCodeMessagesPrepared = async (
  opts: CallClaudeCodeMessagesOptions,
): Promise<ClaudeCodePreparedCallResult> => {
  // `opts.model.id` is the public alias on the catalog; the dated upstream id
  // Anthropic expects on the wire — and that the pricing table keys by — rides
  // on `opts.model.providerData.upstreamModelId`.
  const upstreamModelId = opts.model.providerData.upstreamModelId

  opts.signal?.throwIfAborted()
  const snapshot = await readClaudeCodeCredential(opts.upstreamId, opts.expected, opts.beforeInference !== undefined)
  await validateExecution(opts, snapshot.credential)
  const account = snapshot.account
  if (account.state !== 'active') {
    return { response: synthetic503(`Claude Code account is ${account.state}: ${account.stateMessage}`) }
  }

  const now = new Date()
  const quotaData = account.quotaSnapshot === null ? null : account.quotaSnapshot.data
  if (isRateLimitedNow(quotaData, now)) {
    return { response: synthetic429(
      `Claude Code upstream rate-limited until ${quotaData.reset}`,
      quotaData.reset,
      now,
    ) }
  }

  const ensured = await ensureOrSession503(opts, snapshot)
  if (ensured instanceof Response) return { response: ensured }

  const bodyText = JSON.stringify({ ...opts.body, model: upstreamModelId, stream: true })
  return await performStreamingMessagesCall(opts, upstreamModelId, bodyText, ensured, false)
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
  snapshot?: ClaudeCodeCredentialSnapshot,
  failed?: EnsuredAccessToken,
): Promise<EnsuredAccessToken | Response> => {
  try {
    const args = {
      upstreamId: opts.upstreamId,
      fetcher: opts.fetcher,
      expected: opts.expected,
      signal: opts.signal,
      snapshot,
      beforeMint: async (credential: Readonly<ClaudeCodeCredentialTarget>) => { await validateExecution(opts, credential, true) },
    }
    return failed ? await refreshClaudeCodeAccessTokenForRetry(failed, args) : await ensureClaudeCodeAccessToken(args)
  } catch (err) {
    if (err instanceof ClaudeCodeOAuthSessionTerminatedError) {
      return synthetic503(`Claude Code refresh failed: ${err.upstreamMessage}`)
    }
    if (err instanceof ClaudeCodeCredentialUnavailableError) return synthetic503(err.message)
    throw err
  }
}

async function validateExecution(opts: CallClaudeCodeMessagesOptions, credential: Readonly<ClaudeCodeCredentialTarget>, authoritative = false) {
  opts.signal?.throwIfAborted()
  assertClaudeCodeExecutionAuthority(opts.expected, credential)
  const target = claudeCodeAffinityTarget(credential, opts.model.providerData.upstreamModelId)
  if (opts.beforeInference) {
    if (!target) throw new ClaudeCodeAffinityChangedError()
    await opts.beforeInference(target)
    opts.signal?.throwIfAborted()
  }
  if (authoritative) {
    const current = await readClaudeCodeCredential(opts.upstreamId, opts.expected, true)
    assertClaudeCodeExecutionAuthority(opts.expected, current.credential)
    if (current.account.state !== 'active') throw new ClaudeCodeOAuthSessionTerminatedError({ code: current.account.state, message: current.account.stateMessage })
    if (opts.beforeInference) {
      const actual = claudeCodeAffinityTarget(current.credential, opts.model.providerData.upstreamModelId)
      if (!actual) throw new ClaudeCodeAffinityChangedError()
      await opts.beforeInference(actual)
    }
  }
  opts.signal?.throwIfAborted()
  return target
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
  bodyText: string,
  accessToken: EnsuredAccessToken,
  alreadyRetried: boolean,
): Promise<ClaudeCodePreparedCallResult> => {
  const headers: Record<string, string> = {
    ...(opts.shaped && opts.inboundHeaders
      ? passthroughHeaders(opts.inboundHeaders)
      : pickClaudeCodeHeaders(upstreamModelId)),
    // Provider-owned OAuth always wins: the gateway already stripped the
    // client's own authorization, and only this bearer is valid upstream.
    authorization: `Bearer ${accessToken.entry.token}`,
  }

  const affinityExecution = await validateExecution(opts, accessToken.credential, opts.beforeInference !== undefined)
  opts.signal?.throwIfAborted()
  const response = await (opts.executionFetcher ?? opts.fetcher)(ANTHROPIC_MESSAGES_ENDPOINT, {
    method: 'POST',
    headers,
    body: bodyText,
    signal: opts.signal,
  })
  if (opts.signal?.aborted) {
    await response.body?.cancel()
    opts.signal.throwIfAborted()
  }

  // Every Anthropic response ships an `anthropic-ratelimit-unified-*` snapshot
  // on 2xx and 429. Other statuses (4xx/5xx outside 429) carry no quota signal.
  if (response.ok || response.status === 429) {
    const snapshot = parseClaudeCodeQuotaHeaders(response.headers)
    if (Object.keys(snapshot.raw).length > 0) {
      waitUntil(putClaudeCodeQuota(accessToken, snapshot))
    }
  }

  if (
    response.status === 401 &&
    !accessToken.freshlyMinted &&
    !alreadyRetried
  ) {
    await response.body?.cancel()
    opts.signal?.throwIfAborted()
    const ensured = await ensureOrSession503(opts, undefined, accessToken)
    if (ensured instanceof Response) return { response: ensured }
    return await performStreamingMessagesCall(opts, upstreamModelId, bodyText, ensured, true)
  }

  return { response, affinityExecution, execution: {
    modelKey: upstreamModelId,
    ...(affinityExecution ? { credentialSubject: affinityExecution.credentialSubject, credentialRevision: affinityExecution.credentialRevision } : {}),
  } }
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
