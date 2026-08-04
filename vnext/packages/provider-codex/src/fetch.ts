// Codex terminal HTTP flow for /codex/responses (streaming) and
// /codex/responses/compact (unary). Ported from copilot-gateway/packages/
// provider-codex/src/fetch.ts.
//
// vNext adaptations:
//   - Both terminal callers return raw `Response`. The provider layer wraps
//     into `ProviderResponse { status, headers, body }` — no stream/JSON
//     parsing at this boundary (attempt.ts owns the SSE + JSON decoding).
//   - `opts.call.fetcher` → `opts.fetcher` (Fetcher passed in directly).
//   - `opts.call.wrapUpstreamCall(fn)` → inline `await fn()`.
//   - `opts.call.waitUntil(p)` → `p.catch(() => {})` fire-and-forget. Platform
//     runtime `waitUntil` integration lands in a later circle.
//   - `alpha_search` endpoint intentionally dropped (out of F3 scope).
//   - `CanonicalResponsesCompactPayload` + `toCompactPayloadShape` inlined
//     from copilot-gateway/packages/protocols/src/responses/compact.ts —
//     protocols-llm does not (yet) export the compact wire shape, and only
//     codex is a native-compact provider.

import {
  ensureCodexAccessToken,
  invalidateCodexAccessToken,
  mintCodexAccessToken,
  putCodexAccessToken,
} from './access-token'
import { CodexOAuthSessionTerminatedError } from './auth/oauth'
import {
  CODEX_BACKEND_BASE,
  CODEX_ORIGINATOR,
  CODEX_RESPONSES_COMPACT_PATH,
  CODEX_RESPONSES_PATH,
  CODEX_USER_AGENT,
} from './constants'
import type { Fetcher } from './fetcher'
import { sha256Uuid, uuidV7 } from './ids'
import type { CodexProviderModel } from './models'
import { parseCodexQuotaHeaders, putCodexQuota } from './quota'
import type { CodexAccountCredential } from './state'
import type {
  CanonicalResponsesPayload,
  ResponsesInputItem,
  ResponsesOutputItem,
  ResponsesResult,
} from '@vibe-llm/protocols/responses'

// ─── Inlined compact wire shape ────────────────────────────────────────────
// See copilot-gateway/packages/protocols/src/responses/compact.ts for prov-
// enance. Kept private to provider-codex — no other provider ships a native
// compact endpoint, so the type does not need to live in protocols-llm.

type ResponsesPromptCacheOptions = unknown
type ResponsesPromptCacheRetention = unknown

export interface ResponsesCompactPayload {
  model: string
  input: string | ResponsesInputItem[]
  instructions?: string | null
  previous_response_id?: string | null
  prompt_cache_key?: string | null
  prompt_cache_options?: ResponsesPromptCacheOptions | null
  prompt_cache_retention?: ResponsesPromptCacheRetention | null
  service_tier?: 'default' | 'auto' | 'flex' | 'priority' | 'scale' | (string & {}) | null
  store?: boolean | null
}

export type CanonicalResponsesCompactPayload = Omit<ResponsesCompactPayload, 'input'> & {
  input: ResponsesInputItem[]
}

export interface ResponsesCompactionResult {
  id: string
  object: string
  output: ResponsesOutputItem[]
  created_at?: number
  usage?: ResponsesResult['usage']
}

export const toCompactPayloadShape = (
  payload: Omit<CanonicalResponsesPayload, 'model'>,
): Omit<CanonicalResponsesCompactPayload, 'model' | 'store'> => ({
  input: payload.input as ResponsesInputItem[],
  ...(payload.instructions !== undefined && { instructions: payload.instructions as string | null }),
  ...(payload.previous_response_id !== undefined && { previous_response_id: payload.previous_response_id as string | null }),
  ...(payload.prompt_cache_key !== undefined && { prompt_cache_key: payload.prompt_cache_key as string | null }),
  ...((payload as Record<string, unknown>).prompt_cache_options !== undefined && {
    prompt_cache_options: (payload as Record<string, unknown>).prompt_cache_options as ResponsesPromptCacheOptions,
  }),
  ...((payload as Record<string, unknown>).prompt_cache_retention !== undefined && {
    prompt_cache_retention: (payload as Record<string, unknown>).prompt_cache_retention as ResponsesPromptCacheRetention,
  }),
  ...((payload as Record<string, unknown>).service_tier !== undefined && {
    service_tier: (payload as Record<string, unknown>).service_tier as ResponsesCompactPayload['service_tier'],
  }),
})

// ─── Effects: repo-side state transitions ──────────────────────────────────
// Refresh-token rotations and terminal-state flips travel through the repo
// via these hooks so provider.ts owns the saveState<CodexUpstreamState> call
// shape. Access-token / quota writes flow through their own helpers.
export interface CodexCallEffects {
  persistRefreshTokenRotation(newRefreshToken: string): Promise<void>
  persistTerminalState(state: 'session_terminated' | 'refresh_failed', message: string): Promise<void>
}

interface CodexBackendCallBase {
  upstreamId: string
  account: CodexAccountCredential
  model: CodexProviderModel
  headers: Headers
  signal?: AbortSignal
  effects: CodexCallEffects
  fetcher: Fetcher
}

export interface CallCodexResponsesOptions extends CodexBackendCallBase {
  body: Omit<CanonicalResponsesPayload, 'model'>
}

export interface CallCodexResponsesCompactOptions extends CodexBackendCallBase {
  body: Omit<CanonicalResponsesCompactPayload, 'model' | 'store'>
}

type CodexResponsesBody =
  | CallCodexResponsesOptions['body']
  | CallCodexResponsesCompactOptions['body']

// ─── Entry points ──────────────────────────────────────────────────────────

export const callCodexResponses = async (opts: CallCodexResponsesOptions): Promise<Response> => {
  const ready = await prepareCodexCall(opts)
  if (!ready.ok) return ready.response
  return await performStreamingResponsesCall(opts, ready.accessToken, false)
}

export const callCodexResponsesCompact = async (
  opts: CallCodexResponsesCompactOptions,
): Promise<Response> => {
  const ready = await prepareCodexCall(opts)
  if (!ready.ok) return ready.response
  return await performUnaryCompactCall(opts, ready.accessToken, false)
}

// ─── Pre-fetch gates + initial access-token mint ───────────────────────────

const prepareCodexCall = async (
  opts: CodexBackendCallBase,
): Promise<{ ok: true; accessToken: string } | { ok: false; response: Response }> => {
  if (opts.account.state !== 'active') {
    return { ok: false, response: synthetic503(`Codex upstream is ${opts.account.state}`) }
  }
  try {
    const entry = await ensureCodexAccessToken(
      opts.upstreamId,
      opts.account.chatgptAccountId,
      (refresh) => mintAccessToken(opts, refresh),
    )
    return { ok: true, accessToken: entry.token }
  } catch (err) {
    if (err instanceof CodexOAuthSessionTerminatedError) {
      await opts.effects.persistTerminalState('refresh_failed', err.upstreamMessage)
      return { ok: false, response: synthetic503(`Codex refresh failed: ${err.upstreamMessage}`) }
    }
    throw err
  }
}

const mintAccessToken = (opts: CodexBackendCallBase, refreshToken: string) =>
  mintCodexAccessToken(refreshToken, opts.fetcher, opts.effects.persistRefreshTokenRotation)

// ─── Identity / turn metadata ──────────────────────────────────────────────

interface CodexRequestIdentity {
  installationId: string
  sessionId: string
  threadId: string
  clientRequestId: string
  turnId: string
  windowId: string
}

export interface CodexCompactionTurnMetadata {
  trigger: 'manual' | 'auto'
  reason: 'user_requested' | 'context_limit'
  implementation: 'responses_compact' | 'responses_compaction_v2'
  phase: 'standalone_turn' | 'mid_turn'
  strategy: 'memento'
}

export interface CodexTurnMetadataOptions {
  requestKind: 'turn' | 'compaction'
  compaction?: CodexCompactionTurnMetadata
}

export const CODEX_RESPONSES_COMPACTION_V2_TURN_METADATA: CodexTurnMetadataOptions = {
  requestKind: 'compaction',
  compaction: {
    trigger: 'manual',
    reason: 'user_requested',
    implementation: 'responses_compaction_v2',
    phase: 'standalone_turn',
    strategy: 'memento',
  },
}

const trimHeader = (headers: Headers, name: string): string | null => {
  const value = headers.get(name)?.trim() ?? ''
  return value.length > 0 ? value : null
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const stringField = (record: Record<string, unknown> | null, key: string): string | null => {
  if (record === null) return null
  const value = record[key]
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

const clientCodexClientMetadata = (body: unknown): Record<string, unknown> => {
  if (!isPlainObject(body)) return {}
  const candidate = (body as Record<string, unknown>).client_metadata
  return isPlainObject(candidate) ? candidate : {}
}

const parseClientTurnMetadataJson = (raw: string | null): Record<string, unknown> | null => {
  if (raw === null) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    return isPlainObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

const IDENTITY_MIRRORED_TURN_METADATA_KEYS = new Set<string>([
  'installation_id',
  'session_id',
  'thread_id',
  'turn_id',
  'window_id',
])

const IDENTITY_MIRRORED_CLIENT_METADATA_KEYS = new Set<string>([
  'x-codex-installation-id',
  'session_id',
  'thread_id',
  'x-codex-window-id',
  'turn_id',
  'x-codex-turn-metadata',
])

const buildCodexRequestIdentity = async (
  opts: CodexBackendCallBase,
  body: CodexResponsesBody,
  clientMetadata: Record<string, unknown>,
  clientTurnMetadata: Record<string, unknown> | null,
): Promise<CodexRequestIdentity> => {
  const sessionId =
    trimHeader(opts.headers, 'session-id') ??
    trimHeader(opts.headers, 'session_id') ??
    stringField(clientMetadata, 'session_id') ??
    stringField(clientTurnMetadata, 'session_id') ??
    (await deriveSessionIdFromInput(body)) ??
    uuidV7()
  const threadId =
    trimHeader(opts.headers, 'thread-id') ??
    stringField(clientMetadata, 'thread_id') ??
    stringField(clientTurnMetadata, 'thread_id') ??
    sessionId
  const clientRequestId = trimHeader(opts.headers, 'x-client-request-id') ?? threadId
  const installationId =
    stringField(clientMetadata, 'x-codex-installation-id') ??
    stringField(clientTurnMetadata, 'installation_id') ??
    opts.account.openaiDeviceId
  const windowId =
    trimHeader(opts.headers, 'x-codex-window-id') ??
    stringField(clientMetadata, 'x-codex-window-id') ??
    stringField(clientTurnMetadata, 'window_id') ??
    `${sessionId}:0`
  const turnId =
    stringField(clientMetadata, 'turn_id') ??
    stringField(clientTurnMetadata, 'turn_id') ??
    uuidV7()
  return { installationId, sessionId, threadId, clientRequestId, turnId, windowId }
}

// Session-id derivation gives stateless callers a stable id across turns of
// the same conversation, so chatgpt.com's prompt cache lights up instead of
// missing per request. Seed = instructions + input up to (and including) the
// first user message; subsequent turns append tail items, so the seed shape
// is unchanged. Stateful callers using `previous_response_id` reach here with
// the input already expanded from the snapshot in attempt.ts and therefore
// hash the same prefix as the original turn.
const deriveSessionIdFromInput = async (body: CodexResponsesBody): Promise<string | null> => {
  const input = body.input
  if (typeof input === 'string') return null
  const seed = seedUpToFirstUserMessage(input as ResponsesInputItem[])
  if (seed === null) return null
  const instructions = typeof body.instructions === 'string' ? body.instructions : ''
  // U+0001 separates the two seed components so an empty instructions can't
  // collide with the input prefix via string concatenation.
  return await sha256Uuid(`${instructions}${JSON.stringify(seed)}`)
}

const seedUpToFirstUserMessage = (
  input: readonly ResponsesInputItem[],
): readonly ResponsesInputItem[] | null => {
  const collected: ResponsesInputItem[] = []
  for (const item of input) {
    collected.push(item)
    if (isUserMessageItem(item)) return collected
  }
  return null
}

const isUserMessageItem = (item: ResponsesInputItem): boolean => {
  const anyItem = item as { type?: unknown; role?: unknown }
  return anyItem.type === 'message' && anyItem.role === 'user'
}

const buildCodexTurnMetadata = (
  identity: CodexRequestIdentity,
  options: CodexTurnMetadataOptions,
  clientOverrides: Record<string, unknown> | null,
): Record<string, unknown> => {
  const base: Record<string, unknown> = {
    installation_id: identity.installationId,
    session_id: identity.sessionId,
    thread_id: identity.threadId,
    turn_id: identity.turnId,
    window_id: identity.windowId,
    request_kind: options.requestKind,
  }
  if (options.compaction !== undefined) base.compaction = options.compaction
  if (clientOverrides === null) return base
  for (const [k, v] of Object.entries(clientOverrides)) {
    if (!IDENTITY_MIRRORED_TURN_METADATA_KEYS.has(k)) base[k] = v
  }
  return base
}

const buildCodexTurnMetadataJson = (
  identity: CodexRequestIdentity,
  options: CodexTurnMetadataOptions,
  clientOverrides: Record<string, unknown> | null,
): string => JSON.stringify(buildCodexTurnMetadata(identity, options, clientOverrides))

const buildCodexClientMetadata = (
  identity: CodexRequestIdentity,
  turnMetadataJson: string,
): Record<string, string> => ({
  'x-codex-installation-id': identity.installationId,
  session_id: identity.sessionId,
  thread_id: identity.threadId,
  'x-codex-window-id': identity.windowId,
  turn_id: identity.turnId,
  'x-codex-turn-metadata': turnMetadataJson,
})

const buildCodexResponsesBody = (
  opts: CallCodexResponsesOptions,
  identity: CodexRequestIdentity,
  turnMetadataJson: string,
): Record<string, unknown> => {
  const callerExtras: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(clientCodexClientMetadata(opts.body))) {
    if (!IDENTITY_MIRRORED_CLIENT_METADATA_KEYS.has(k)) callerExtras[k] = v
  }
  const body: Record<string, unknown> = {
    ...(opts.body as unknown as Record<string, unknown>),
    model: opts.model.id,
    store: false,
    stream: true,
    client_metadata: {
      ...buildCodexClientMetadata(identity, turnMetadataJson),
      ...callerExtras,
    },
  }
  if (body.prompt_cache_key === undefined) body.prompt_cache_key = identity.threadId
  return body
}

// ─── HTTP dispatch ─────────────────────────────────────────────────────────
// One upstream round-trip with quota-header persistence and terminal-401
// classification. The returned Response is what the caller relays:
//   - 2xx: caller streams/parses the body
//   - 429: quota is already snapshotted; return verbatim
//   - 401: `token_invalidated` → synthetic 503 (terminal); other 401 rebuilt
//     with a re-readable body so the caller can retry with a fresh token
//   - other: returned verbatim

const dispatchCodexHttpCall = async (
  opts: CodexBackendCallBase,
  accessToken: string,
  path: string,
  accept: string,
  body: Record<string, unknown>,
  identity: CodexRequestIdentity,
  turnMetadataJson: string | null,
): Promise<Response> => {
  const headers = new Headers()
  headers.set('authorization', `Bearer ${accessToken}`)
  headers.set('chatgpt-account-id', opts.account.chatgptAccountId)
  headers.set('originator', CODEX_ORIGINATOR)
  headers.set('user-agent', CODEX_USER_AGENT)
  headers.set('accept', accept)
  headers.set('content-type', 'application/json')
  headers.set('session-id', identity.sessionId)
  headers.set('thread-id', identity.threadId)
  headers.set('x-client-request-id', identity.clientRequestId)
  headers.set('x-codex-window-id', identity.windowId)
  if (turnMetadataJson !== null) headers.set('x-codex-turn-metadata', turnMetadataJson)

  const response = await opts.fetcher(`${CODEX_BACKEND_BASE}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: opts.signal,
  })

  if (response.ok) {
    const responseNow = new Date()
    const snapshot = parseCodexQuotaHeaders(response.headers, {
      now: responseNow,
      isRateLimited: false,
    })
    registerBackgroundWrite(
      putCodexQuota(opts.upstreamId, opts.account.chatgptAccountId, snapshot),
    )
    return response
  }

  if (response.status === 429) {
    const responseNow = new Date()
    const snapshot = parseCodexQuotaHeaders(response.headers, {
      now: responseNow,
      isRateLimited: true,
    })
    registerBackgroundWrite(
      putCodexQuota(opts.upstreamId, opts.account.chatgptAccountId, snapshot),
    )
    return response
  }

  if (response.status === 401) {
    const bodyText = await response.text()
    const { code, message } = parseUpstreamError(bodyText)
    if (code === 'token_invalidated') {
      await opts.effects.persistTerminalState('session_terminated', message)
      return synthetic503(`Codex session terminated: ${message}`)
    }
    return new Response(bodyText, { status: 401, headers: response.headers })
  }

  return response
}

// Force-mint a fresh access token after a 401. See reference-project comment
// for full rationale — TL;DR: read-then-maybe-mint can re-observe the invalid
// token because a sibling's own mint lands its `put` after our `invalidate`.
const refreshAccessTokenForRetry = async (
  opts: CodexBackendCallBase,
): Promise<{ ok: true; accessToken: string } | { ok: false; response: Response }> => {
  await invalidateCodexAccessToken(opts.upstreamId, opts.account.chatgptAccountId)
  try {
    const minted = await mintAccessToken(opts, opts.account.refresh_token)
    registerBackgroundWrite(
      putCodexAccessToken(opts.upstreamId, opts.account.chatgptAccountId, minted),
    )
    return { ok: true, accessToken: minted.token }
  } catch (err) {
    if (err instanceof CodexOAuthSessionTerminatedError) {
      await opts.effects.persistTerminalState('refresh_failed', err.upstreamMessage)
      return { ok: false, response: synthetic503(`Codex refresh failed: ${err.upstreamMessage}`) }
    }
    throw err
  }
}

// ─── Streaming responses call ──────────────────────────────────────────────

const performStreamingResponsesCall = async (
  opts: CallCodexResponsesOptions,
  accessToken: string,
  alreadyRetried: boolean,
): Promise<Response> => {
  const clientTurnMetadata = parseClientTurnMetadataJson(
    trimHeader(opts.headers, 'x-codex-turn-metadata'),
  )
  const clientMetadata = clientCodexClientMetadata(opts.body)
  const identity = await buildCodexRequestIdentity(
    opts,
    opts.body,
    clientMetadata,
    clientTurnMetadata,
  )
  const hasCompactionTrigger = (opts.body.input as ResponsesInputItem[]).some(
    (item: ResponsesInputItem) => (item as { type?: unknown }).type === 'compaction_trigger',
  )
  const metadata: CodexTurnMetadataOptions = hasCompactionTrigger
    ? CODEX_RESPONSES_COMPACTION_V2_TURN_METADATA
    : { requestKind: 'turn' }
  const turnMetadataJson = buildCodexTurnMetadataJson(identity, metadata, clientTurnMetadata)
  const response = await dispatchCodexHttpCall(
    opts,
    accessToken,
    CODEX_RESPONSES_PATH,
    'text/event-stream',
    buildCodexResponsesBody(opts, identity, turnMetadataJson),
    identity,
    turnMetadataJson,
  )

  if (response.status === 401 && !alreadyRetried) {
    const fresh = await refreshAccessTokenForRetry(opts)
    if (!fresh.ok) return fresh.response
    return await performStreamingResponsesCall(opts, fresh.accessToken, true)
  }

  if (response.ok) return ensureSseContentType(response)
  return response
}

// ─── Unary compact call ────────────────────────────────────────────────────

const performUnaryCompactCall = async (
  opts: CallCodexResponsesCompactOptions,
  accessToken: string,
  alreadyRetried: boolean,
): Promise<Response> => {
  const clientTurnMetadata = parseClientTurnMetadataJson(
    trimHeader(opts.headers, 'x-codex-turn-metadata'),
  )
  const clientMetadata = clientCodexClientMetadata(opts.body)
  const identity = await buildCodexRequestIdentity(
    opts,
    opts.body,
    clientMetadata,
    clientTurnMetadata,
  )
  const metadata: CodexTurnMetadataOptions = { requestKind: 'compaction' }
  const turnMetadataJson = buildCodexTurnMetadataJson(identity, metadata, clientTurnMetadata)
  const response = await dispatchCodexHttpCall(
    opts,
    accessToken,
    CODEX_RESPONSES_COMPACT_PATH,
    'application/json',
    { ...opts.body, model: opts.model.id },
    identity,
    turnMetadataJson,
  )

  if (response.status === 401 && !alreadyRetried) {
    const fresh = await refreshAccessTokenForRetry(opts)
    if (!fresh.ok) return fresh.response
    return await performUnaryCompactCall(opts, fresh.accessToken, true)
  }

  return response
}

// ─── Small utilities ───────────────────────────────────────────────────────

const parseUpstreamError = (rawText: string): { code: string | null; message: string } => {
  try {
    const obj = JSON.parse(rawText) as {
      error?: { code?: unknown; message?: unknown }
      detail?: unknown
    }
    const code =
      obj.error && typeof obj.error === 'object' && typeof obj.error.code === 'string'
        ? obj.error.code
        : null
    const message =
      obj.error && typeof obj.error === 'object' && typeof obj.error.message === 'string'
        ? obj.error.message
        : typeof obj.detail === 'string'
          ? obj.detail
          : rawText.slice(0, 256)
    return { code, message }
  } catch {
    return { code: null, message: rawText.slice(0, 256) }
  }
}

const synthetic503 = (message: string): Response =>
  new Response(
    JSON.stringify({ error: { type: 'codex_upstream_unavailable', message } }),
    { status: 503, headers: { 'content-type': 'application/json' } },
  )

// Codex backend serves SSE without setting `content-type: text/event-stream`
// (observed in production). Downstream consumers gate SSE parsing on the
// content-type header, so we synthesize it on the way through. Body stream
// is preserved verbatim.
const ensureSseContentType = (response: Response): Response => {
  if (response.headers.get('content-type')?.includes('text/event-stream')) return response
  const headers = new Headers(response.headers)
  headers.set('content-type', 'text/event-stream')
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

// Fire-and-forget background persistence. The platform-runtime `waitUntil`
// wrapper lands in a later circle; for now we swallow rejections so a
// transient storage error can't fail the in-flight request.
const registerBackgroundWrite = (write: Promise<void>): void => {
  void write.catch(() => {})
}
