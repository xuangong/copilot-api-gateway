// Claude Code terminal HTTP flow for /v1/messages (streaming). Ported from
// copilot-gateway/packages/provider-claude-code/src/fetch.ts.
//
// vNext adaptations vs reference (~469 LOC → ~180 LOC):
//   - Return raw `Response`; provider.ts wraps into `ProviderResponse`.
//   - Fetcher passed directly (no `opts.call.fetcher`).
//   - Background writes go through `waitUntil` from `@vibe-core/platform`;
//     platform bootstrap owns Node vs workerd semantics.
//   - Shaped-passthrough / re-mimicry fork removed — every call ships the
//     pinned mimicry surface (`pickClaudeCodeHeaders`). The gateway boundary
//     hands us a canonical body; if a caller sends verbatim CC traffic later,
//     add the allowlist path back.
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
import { parseClaudeCodeQuotaHeaders, putClaudeCodeQuota } from './quota'
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

  const ensured = await ensureOrSession503(opts)
  if (ensured instanceof Response) return ensured

  return await performStreamingMessagesCall(opts, upstreamModelId, ensured, false)
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

const performStreamingMessagesCall = async (
  opts: CallClaudeCodeMessagesOptions,
  upstreamModelId: string,
  accessToken: EnsuredAccessToken,
  alreadyRetried: boolean,
): Promise<Response> => {
  const headers: Record<string, string> = {
    ...pickClaudeCodeHeaders(upstreamModelId),
    authorization: `Bearer ${accessToken.entry.token}`,
  }

  // Force stream:true regardless of caller intent — the gateway boundary
  // consumes an SSE envelope; non-streaming Messages is routed elsewhere.
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
