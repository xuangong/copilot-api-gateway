// vnext/packages/gateway/src/data-plane/chat-flow/chat-completions/serve.ts
/**
 * Chat Completions HTTP serve layer (Spec 10 — chat-flow convergence).
 *
 * Migrated to the framework kit (@vibe-core/chat-flow-kit). The old
 * inline parse → telemetry → quota → AbortController → attempt → respond
 * chain now lives behind `serveTemplate(...)`; this file only declares the
 * endpoint-specific hooks and shapes the inbound DataPlaneAuthCtx into the
 * intersection auth type the kit needs.
 *
 * Why the intersection? `ChatCompletionsAttemptAuth` (= SelectBindingAuth)
 * has `{ownerId?, pin?, copilot?}` but no `apiKeyId`. The kit requires
 * `TAuth extends KitAuthCtx` (which contributes `apiKeyId`) so it can run
 * quota and tag telemetry. We intersect the two locally so the existing
 * attempt-auth type stays untouched; structural typing means the extra
 * `apiKeyId` field is silently ignored when `runAttempt` forwards `auth`
 * down to `chatCompletionsAttempt.generate`.
 *
 * Reference: Spec 10 §3.4.
 */
import { serveTemplate, type KitAuthCtx, type KitDumpSink, type KitObsCtx, type ServeTemplateHooks } from '@vibe-core/chat-flow-kit'
import type { DataPlaneAuthCtx } from '../../models/routes.ts'
import { parseChatPayload } from '../../parsers.ts'
import { resolveKeyModel } from '../../routing/key-model-mapping.ts'
import { kitDeps } from '../shared/kit-deps.ts'
import type { DispatchObsCtx } from '../shared/gateway-ctx.ts'
import type { TelemetryRequestContext } from '../shared/telemetry-ctx.ts'
import { chatCompletionsAttempt, type ChatCompletionsAttemptAuth, type ChatCompletionsAttemptResult } from './attempt.ts'
import { respondChatCompletions } from './respond.ts'
import type { DumpAccumulator } from '../../../shared/dump/accumulator.ts'

export interface ChatCompletionsServeArgs {
  /** Pre-parsed JSON body from http.ts (`await c.req.json()`). */
  readonly raw: unknown
  readonly auth: DataPlaneAuthCtx
  readonly obsCtx: DispatchObsCtx
  /**
   * Optional client-side abort signal (Hono's `c.req.raw.signal`). When the
   * client disconnects we propagate the abort down to provider.fetch via a
   * controller the kit links internally.
   */
  readonly signal?: AbortSignal
  /** Opaque per-request dump sink (null when the api key has no retention). */
  readonly dump?: KitDumpSink | null
}

type ChatCompletionsPayload = Record<string, unknown> & {
  model: string
  stream?: boolean
  stream_options?: { include_usage?: boolean }
}

/**
 * Wrapper-local intersection auth. See module header for why this is
 * necessary — the kit needs apiKeyId for quota, attempt does not.
 */
type ChatCompletionsServeAuth = ChatCompletionsAttemptAuth & KitAuthCtx & Pick<DataPlaneAuthCtx, 'routingPolicy'>
type ChatCompletionsExtra = { readonly incomingModel: string; readonly upstreamPin?: string }

const chatCompletionsHooks: ServeTemplateHooks<
  ChatCompletionsPayload,
  ChatCompletionsAttemptResult,
  ChatCompletionsExtra,
  ChatCompletionsServeAuth,
  TelemetryRequestContext
> = {
  endpointTag: 'chat_completions',

  parse: ({ raw }) => {
    try {
      return parseChatPayload(raw) as ChatCompletionsPayload
    } catch (err) {
      const e = err as Error & { status?: number; body?: unknown }
      const wrapped = new Error(e.message) as Error & { status?: number; body?: unknown }
      wrapped.status = e.status ?? 400
      wrapped.body = e.body ?? {
        error: { type: 'invalid_request_error', message: e.message },
      }
      throw wrapped
    }
  },

  preProcess: async (payload, ctx) => {
    const resolved = resolveKeyModel(payload.model, ctx.auth.routingPolicy)
    return {
      kind: 'continue',
      payload: { ...payload, model: resolved.routedModel },
      extra: { incomingModel: resolved.incomingModel, ...(resolved.upstreamPin ? { upstreamPin: resolved.upstreamPin } : {}) },
    }
  },

  wantsStream: (p) => p.stream === true,

  runAttempt: (a) => chatCompletionsAttempt.generate({
    payload: a.payload,
    auth: a.extra?.upstreamPin ? { ...a.auth, pin: a.extra.upstreamPin } : a.auth,
    // Same as messages/serve.ts: the web-search shim resolves engines from the
    // caller's key, so the interceptors need the id.
    ctx: { requestStartedAt: a.requestStartedAt, downstreamAbortSignal: a.downstreamAbortSignal, apiKeyId: a.auth.apiKeyId },
    telemetryCtx: a.telemetryCtx,
  }),

  respond: (r, c) => respondChatCompletions(r, {
    wantsStream: c.wantsStream,
    includeUsageChunk: c.payload.stream_options?.include_usage === true,
    downstreamAbortController: c.downstreamAbortController,
    telemetryCtx: c.telemetryCtx,
    ...(c.dump !== undefined && c.dump !== null && { dump: c.dump as DumpAccumulator }),
  }),
}

export async function serveChatCompletions(args: ChatCompletionsServeArgs): Promise<Response> {
  const auth: ChatCompletionsServeAuth = {
    ownerId: args.auth.userId,
    copilot: args.auth.copilot,
    apiKeyId: args.auth.apiKeyId,
    routingPolicy: args.auth.routingPolicy,
  }
  const { response } = await serveTemplate(
    chatCompletionsHooks,
    { raw: args.raw, auth, obsCtx: args.obsCtx as KitObsCtx, signal: args.signal, extras: {}, dump: args.dump ?? null },
    kitDeps,
  )
  return response
}
