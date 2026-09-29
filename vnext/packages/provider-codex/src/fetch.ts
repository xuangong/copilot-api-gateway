// Codex terminal HTTP flow for /codex/responses (streaming) and
// /codex/responses/compact (unary). Ported from copilot-gateway/packages/
// provider-codex/src/fetch.ts.
//
// vNext adaptations:
//   - Public transport callers retain native Response. Prepared entrypoints
//     carry call-local protocol adapters to the provider; attempt.ts owns
//     SSE / JSON decoding and applies adapters before observing source data.
//   - `opts.call.fetcher` → `opts.fetcher` (Fetcher passed in directly).
//   - `opts.call.wrapUpstreamCall(fn)` → inline `await fn()` (TTFT timing lands
//     with the telemetry circle; see CUTOVER TODO).
//   - `opts.call.waitUntil(p)` → module-level `waitUntil` from
//     `@vibe-core/platform`; platform bootstrap owns the Node vs workerd
//     implementation, providers just publish the promise.
//   - `alpha_search` endpoint intentionally dropped (out of F3 scope).
//   - `CanonicalResponsesCompactPayload` + `toCompactPayloadShape` inlined
//     from copilot-gateway/packages/protocols/src/responses/compact.ts —
//     protocols-llm does not (yet) export the compact wire shape, and only
//     codex is a native-compact provider.

import {
  ensureCodexAccessToken,
  mintCodexAccessToken,
  refreshCodexAccessTokenForRetry,
  CodexAccessRejectedError,
  CodexCredentialExpiredError,
  CodexCredentialUnavailableError,
  type CodexAccessTokenLease,
} from './access-token'
import { CodexOAuthSessionTerminatedError } from './auth/oauth'
import { codexBearerEffect, persistCodexTerminalState, readCodexCredential, type CodexCredentialTarget } from './credential-effects'
import {
  CODEX_ALPHA_SEARCH_PATH,
  CODEX_BACKEND_BASE,
  CODEX_ORIGINATOR,
  CODEX_RESPONSES_COMPACT_PATH,
  CODEX_RESPONSES_PATH,
  CODEX_USER_AGENT,
} from './constants'
import type { Fetcher } from './fetcher'
import { sha256UuidFromParts, uuidV7 } from './ids'
import { codexModelUsesResponsesLite, type CodexProviderModel } from './models'
import { encodeCodexResponsesLiteRequest, createCodexResponsesLiteAdapter, restoreCodexResponsesCompactionResult, type CodexResponsesBody as LiteBody, type CodexResponsesLiteRequest } from './responses-lite'
import type { ProviderResponse } from '@vibe-llm/provider-llm'
import { parseCodexQuotaHeaders, putCodexQuota } from './quota'
import type { CodexAccountCredential, CodexQuotaSnapshotEntryMap } from './state'
import type {
  CanonicalResponsesPayload,
  ResponsesInputItem,
  ResponsesOutputItem,
  ResponsesResult,
} from '@vibe-llm/protocols/responses'
import { waitUntil } from '@vibe-core/platform'

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

interface CodexBackendCallBase {
  upstreamId: string
  account: CodexAccountCredential
  credential: CodexCredentialTarget
  model: CodexProviderModel
  headers: Headers
  signal?: AbortSignal
  fetcher: Fetcher
  executionFetcher?: Fetcher
}

export interface CallCodexResponsesOptions extends CodexBackendCallBase {
  body: Omit<CanonicalResponsesPayload, 'model'>
}

export interface CallCodexResponsesCompactOptions extends CodexBackendCallBase {
  // Keep declarations until Lite encoding has captured their provenance.
  body: Omit<CanonicalResponsesPayload, 'model'>
}

export interface CallCodexAlphaSearchOptions extends CodexBackendCallBase {
  body: Record<string, unknown>
}

type CodexResponsesBody =
  | CallCodexResponsesOptions['body']
  | CallCodexResponsesCompactOptions['body']

// ─── Entry points ──────────────────────────────────────────────────────────

export interface CodexPreparedCallResult {
  response: Response
  responsesAdapter?: ProviderResponse['responsesAdapter']
  compactAdapter?: ProviderResponse['compactAdapter']
}

export const callCodexResponses = async (opts: CallCodexResponsesOptions): Promise<Response> =>
  (await callCodexResponsesPrepared(opts)).response

export const callCodexResponsesCompact = async (opts: CallCodexResponsesCompactOptions): Promise<Response> =>
  (await callCodexResponsesCompactPrepared(opts)).response

export const callCodexResponsesPrepared = (opts: CallCodexResponsesOptions): Promise<CodexPreparedCallResult> =>
  callPreparedResponses(opts, false)

export const callCodexResponsesCompactPrepared = (opts: CallCodexResponsesCompactOptions): Promise<CodexPreparedCallResult> =>
  callPreparedResponses(opts, true)

const callPreparedResponses = async (
  opts: CallCodexResponsesOptions,
  compact: boolean,
): Promise<CodexPreparedCallResult> => {
  const ready = await prepareCodexCall(opts)
  if (!ready.ok) return { response: ready.response }
  const prepared = await prepareResponsesHttpCall(opts, compact)
  const response = await performPreparedResponsesCall(opts, ready.accessToken, compact, prepared)
  const lite = prepared.lite
  return {
    response,
    ...(lite && (compact
      ? { compactAdapter: (result: Parameters<typeof restoreCodexResponsesCompactionResult>[0]) =>
          restoreCodexResponsesCompactionResult(result, lite.callableIdentities, lite.generatedPrefix) }
      : { responsesAdapter: createCodexResponsesLiteAdapter(lite) })),
  }
}

export const callCodexAlphaSearch = async (
  opts: CallCodexAlphaSearchOptions,
): Promise<Response> => {
  const requestId = stringField(opts.body, 'id') ?? uuidV7()
  const normalized: CallCodexAlphaSearchOptions = {
    ...opts,
    body: { ...opts.body, id: requestId },
  }
  const ready = await prepareCodexCall(normalized)
  if (!ready.ok) return ready.response
  return await performAlphaSearchCall(normalized, ready.accessToken, false)
}

// ─── Pre-fetch gates + initial access-token mint ───────────────────────────

const prepareCodexCall = async (
  opts: CodexBackendCallBase,
): Promise<{ ok: true; accessToken: CodexAccessTokenLease } | { ok: false; response: Response }> => {
  const { account } = await readCodexCredential(opts.upstreamId, opts.account.chatgptAccountId, opts.credential)
  if (account.state !== 'active') {
    return { ok: false, response: synthetic503(account.state === 'access_rejected' ? 'access_rejected' : 'credential_unavailable') }
  }
  const now = new Date()
  const blockedUntil = rateLimitedUntil(account.quotaSnapshot, now)
  if (blockedUntil !== null) {
    return {
      ok: false,
      response: synthetic429(`Codex upstream rate-limited until ${blockedUntil}`, blockedUntil, now),
    }
  }
  try {
    const entry = await ensureCodexAccessToken(
      opts.upstreamId,
      opts.account.chatgptAccountId,
      (refresh, signal) => mintAccessToken(opts, refresh, signal),
      false,
      opts.credential,
      opts.signal,
    )
    return { ok: true, accessToken: entry }
  } catch (err) {
    if (err instanceof CodexOAuthSessionTerminatedError) {
      return { ok: false, response: synthetic503('refresh_failed') }
    }
    if (err instanceof CodexCredentialExpiredError) {
      return { ok: false, response: synthetic503('credential_expired') }
    }
    if (err instanceof CodexAccessRejectedError) {
      return { ok: false, response: synthetic503('access_rejected') }
    }
    if (err instanceof CodexCredentialUnavailableError) {
      return { ok: false, response: synthetic503('credential_unavailable') }
    }
    throw err
  }
}

const mintAccessToken = (opts: CodexBackendCallBase, refreshToken: string, signal?: AbortSignal) =>
  mintCodexAccessToken(refreshToken, opts.fetcher, signal)

// ─── Pre-flight quota gate ─────────────────────────────────────────────────
// Returns the ISO instant this account is blocked until, or null when it is
// free to dispatch. `ratelimited_until` is stamped by `parseCodexQuotaHeaders`
// only on a real 429, so a non-null future value means the upstream already
// told us it is rejecting; short-circuit at the gate so we don't burn an OAuth
// refresh on a request that has no chance.
//
// No reference implementation to port here: copilot-gateway writes
// `ratelimited_until` but never reads it back. Two deliberate non-signals,
// mirroring the claude-code gate's anti-false-positive rules:
//
//   - `primary_used_percent` / `secondary_used_percent` are utilization
//     reports, not rejections. An account can sit at 100% and still be served
//     (spillover to credits, window rolling over mid-request); gating on
//     utilization would refuse requests the upstream would have honoured.
//   - a bucket with no `ratelimited_until` never gates, whatever else it
//     carries. Without a horizon the gate could never expire on its own, and
//     no later request would fire to refresh the snapshot.
//
// Buckets are keyed by `active_limit`, and the governing limit is only known
// from the response headers — so any blocked bucket gates, and we report the
// furthest horizon among them.
const rateLimitedUntil = (
  snapshot: CodexQuotaSnapshotEntryMap | null,
  now: Date,
): string | null => {
  if (!snapshot) return null
  let furthest: string | null = null
  for (const entry of Object.values(snapshot)) {
    const until = entry.data.ratelimited_until
    if (!until) continue
    const ms = new Date(until).getTime()
    if (!Number.isFinite(ms) || ms <= now.getTime()) continue
    if (furthest === null || ms > new Date(furthest).getTime()) furthest = until
  }
  return furthest
}

// ─── Identity / turn metadata ──────────────────────────────────────────────

export interface CodexRequestIdentity {
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
  'ws_request_header_x_openai_internal_codex_responses_lite',
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
  const seedJson = JSON.stringify(seed)
  return await sha256UuidFromParts([instructions, '\u0001', seedJson])
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
//   - 401: `token_invalidated` → synthetic 503 (terminal); other 401 resends
//     the prepared body with a fresh token
//   - other: returned verbatim

export interface PreparedCodexHttpCall {
  originalBody?: LiteBody
  lite?: CodexResponsesLiteRequest
  body: Record<string, unknown>
  identity: CodexRequestIdentity
  turnMetadataJson: string | null
  bodyPrepared: boolean
  bodyText: string | undefined
  accountId: string
}

const codexHttpCall = (
  body: Record<string, unknown>,
  identity: CodexRequestIdentity,
  turnMetadataJson: string | null,
): PreparedCodexHttpCall => ({
  body,
  identity,
  turnMetadataJson,
  bodyPrepared: false,
  bodyText: undefined,
  accountId: '',
})

const dispatchCodexHttpCall = async (
  opts: CodexBackendCallBase,
  accessToken: CodexAccessTokenLease,
  path: string,
  accept: string,
  prepared: PreparedCodexHttpCall,
): Promise<Response> => {
  const headers = new Headers()
  headers.set('authorization', `Bearer ${accessToken.token}`)
  const accountId = prepared.bodyPrepared ? prepared.accountId : opts.account.chatgptAccountId
  headers.set('chatgpt-account-id', accountId)
  headers.set('originator', CODEX_ORIGINATOR)
  headers.set('user-agent', CODEX_USER_AGENT)
  headers.set('accept', accept)
  headers.set('content-type', 'application/json')
  headers.set('session-id', prepared.identity.sessionId)
  headers.set('thread-id', prepared.identity.threadId)
  headers.set('x-client-request-id', prepared.identity.clientRequestId)
  headers.set('x-codex-window-id', prepared.identity.windowId)
  if (prepared.lite) headers.set('x-openai-internal-codex-responses-lite', 'true')
  if (prepared.turnMetadataJson !== null) headers.set('x-codex-turn-metadata', prepared.turnMetadataJson)

  if (!prepared.bodyPrepared) {
    prepared.bodyText = JSON.stringify(prepared.body)
    prepared.accountId = accountId
    prepared.bodyPrepared = true
  }

  const response = await (opts.executionFetcher ?? opts.fetcher)(`${CODEX_BACKEND_BASE}${path}`, {
    method: 'POST',
    headers,
    body: prepared.bodyText,
    signal: opts.signal,
  })

  if (response.ok) {
    const responseNow = new Date()
    const snapshot = parseCodexQuotaHeaders(response.headers, {
      now: responseNow,
      isRateLimited: false,
    })
    waitUntil(
      putCodexQuota(accessToken, snapshot),
    )
    return response
  }

  if (response.status === 429) {
    const responseNow = new Date()
    const snapshot = parseCodexQuotaHeaders(response.headers, {
      now: responseNow,
      isRateLimited: true,
    })
    waitUntil(
      putCodexQuota(accessToken, snapshot),
    )
    return response
  }

  if (response.status === 401) {
    const bodyText = await response.text()
    const { code } = parseUpstreamError(bodyText)
    if (code === 'token_invalidated') {
      await persistCodexTerminalState(codexBearerEffect(accessToken), 'session_terminated', 'token_invalidated')
      return synthetic503('session_terminated')
    }
    return new Response(bodyText, { status: 401, headers: response.headers })
  }

  return response
}

// Recovery selects authoritative credentials before touching the failed bearer.
const refreshAccessTokenForRetry = async (
  opts: CodexBackendCallBase,
  failed: CodexAccessTokenLease,
): Promise<{ ok: true; accessToken: CodexAccessTokenLease } | { ok: false; response: Response }> => {
  try {
    const accessToken = await refreshCodexAccessTokenForRetry(failed, (refresh, signal) => mintAccessToken(opts, refresh, signal), opts.signal)
    return { ok: true, accessToken }
  } catch (err) {
    if (err instanceof CodexOAuthSessionTerminatedError) {
      return { ok: false, response: synthetic503('refresh_failed') }
    }
    if (err instanceof CodexAccessRejectedError) {
      return { ok: false, response: synthetic503('access_rejected') }
    }
    throw err
  }
}

// Responses preparation is outside the auth retry: serialized bytes, prefix
// provenance and request identity all belong to this one logical call.
const prepareResponsesHttpCall = async (
  opts: CallCodexResponsesOptions,
  compact: boolean,
): Promise<PreparedCodexHttpCall> => {
  const clientTurnMetadata = parseClientTurnMetadataJson(trimHeader(opts.headers, 'x-codex-turn-metadata'))
  const clientMetadata = clientCodexClientMetadata(opts.body)
  const identity = await buildCodexRequestIdentity(opts, opts.body, clientMetadata, clientTurnMetadata)
  const input = opts.body.input as ResponsesInputItem[]
  const hasCompactionTrigger = !compact && (opts.body.input as ResponsesInputItem[]).some(
    item => (item as { type?: unknown }).type === 'compaction_trigger',
  )
  const metadata: CodexTurnMetadataOptions = compact
    ? { requestKind: 'compaction' }
    : hasCompactionTrigger ? CODEX_RESPONSES_COMPACTION_V2_TURN_METADATA : { requestKind: 'turn' }
  const turnMetadataJson = buildCodexTurnMetadataJson(identity, metadata, clientTurnMetadata)
  const originalBody = { ...opts.body, input } as LiteBody
  const lite = codexModelUsesResponsesLite(opts.model)
    ? encodeCodexResponsesLiteRequest(originalBody, identity.threadId)
    : undefined
  const encoded = lite?.body ?? originalBody
  const body = compact
    ? { ...toCompactPayloadShape(encoded), model: opts.model.id }
    : buildCodexResponsesBody({ ...opts, body: encoded }, identity, turnMetadataJson)
  return {
    ...codexHttpCall(body, identity, turnMetadataJson),
    originalBody,
    lite,
    bodyText: JSON.stringify(body),
    bodyPrepared: true,
    accountId: opts.account.chatgptAccountId,
  }
}

const performPreparedResponsesCall = async (
  opts: CallCodexResponsesOptions,
  accessToken: CodexAccessTokenLease,
  compact: boolean,
  prepared: PreparedCodexHttpCall,
  alreadyRetried = false,
): Promise<Response> => {
  const response = await dispatchCodexHttpCall(
    opts, accessToken,
    compact ? CODEX_RESPONSES_COMPACT_PATH : CODEX_RESPONSES_PATH,
    compact ? 'application/json' : 'text/event-stream',
    prepared,
  )
  if (response.status === 401 && !alreadyRetried) {
    const fresh = await refreshAccessTokenForRetry(opts, accessToken)
    if (!fresh.ok) return fresh.response
    return performPreparedResponsesCall(opts, fresh.accessToken, compact, prepared, true)
  }
  return response.ok && !compact ? ensureSseContentType(response) : response
}

// ─── Alpha search call ─────────────────────────────────────────────────────

const performAlphaSearchCall = async (
  opts: CallCodexAlphaSearchOptions,
  accessToken: CodexAccessTokenLease,
  alreadyRetried: boolean,
  preparedCall?: PreparedCodexHttpCall,
): Promise<Response> => {
  let prepared = preparedCall
  if (!prepared) {
    const requestId = stringField(opts.body, 'id')
    if (requestId === null) {
      throw new Error('Normalized Codex alpha search request is missing id')
    }
    const identity: CodexRequestIdentity = {
      installationId: opts.account.openaiDeviceId,
      sessionId: requestId,
      threadId: requestId,
      clientRequestId: requestId,
      turnId: uuidV7(),
      windowId: `${requestId}:0`,
    }
    const turnMetadataJson = trimHeader(opts.headers, 'x-codex-turn-metadata')
    prepared = codexHttpCall({ ...opts.body, model: opts.model.id }, identity, turnMetadataJson)
  }
  const response = await dispatchCodexHttpCall(
    opts,
    accessToken,
    CODEX_ALPHA_SEARCH_PATH,
    'application/json',
    prepared,
  )

  if (response.status === 401 && !alreadyRetried) {
    const fresh = await refreshAccessTokenForRetry(opts, accessToken)
    if (!fresh.ok) return fresh.response
    return await performAlphaSearchCall(opts, fresh.accessToken, true, prepared)
  }

  return response
}

// ─── Small utilities ───────────────────────────────────────────────────────

const parseUpstreamError = (rawText: string): { code: string | null } => {
  try {
    const obj: unknown = JSON.parse(rawText)
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return { code: null }
    const error = (obj as Record<string, unknown>).error
    const code =
      error && typeof error === 'object' && !Array.isArray(error) && typeof (error as Record<string, unknown>).code === 'string'
        ? (error as Record<string, string>).code ?? null
        : null
    return { code }
  } catch {
    return { code: null }
  }
}

const synthetic503 = (message: string): Response =>
  new Response(
    JSON.stringify({ error: { type: 'codex_upstream_unavailable', message } }),
    { status: 503, headers: { 'content-type': 'application/json' } },
  )

const synthetic429 = (message: string, retryAtIso: string, now: Date): Response =>
  new Response(
    JSON.stringify({ error: { type: 'codex_rate_limited', message, retry_at: retryAtIso } }),
    {
      status: 429,
      headers: {
        'content-type': 'application/json',
        'retry-after': String(
          Math.max(0, Math.ceil((new Date(retryAtIso).getTime() - now.getTime()) / 1000)),
        ),
      },
    },
  )

// Codex backend serves SSE without setting `content-type: text/event-stream`
// (observed in production). Downstream consumers gate SSE parsing on the
// content-type header, so we synthesize it on the way through. Body stream
// is preserved verbatim.
const ensureSseContentType = (response: Response): Response => {
  const contentType = response.headers.get('content-type') ?? ''
  if (contentType.includes('text/event-stream') || contentType.includes('application/json')) return response
  const headers = new Headers(response.headers)
  headers.set('content-type', 'text/event-stream')
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}
