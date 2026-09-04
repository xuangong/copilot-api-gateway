// vnext/packages/gateway/src/data-plane/chat-flow/messages/serve.ts
/**
 * Anthropic Messages HTTP serve layer (Spec 10 — chat-flow convergence).
 *
 * Migrated to the framework kit (@vibe-core/chat-flow-kit). The old
 * inline parse → telemetry → quota → AbortController → attempt → respond
 * chain now lives behind `serveTemplate(...)`; this file only declares the
 * endpoint-specific hooks and shapes the inbound DataPlaneAuthCtx into the
 * intersection auth type the kit needs.
 *
 * Why the intersection? `MessagesAttemptAuth` has `{ownerId?, pin?, copilot?}`
 * but no `apiKeyId`. The kit requires `TAuth extends KitAuthCtx` so it can
 * run quota + tag telemetry. The wrapper-local
 * `MessagesServeAuth = MessagesAttemptAuth & KitAuthCtx` satisfies the kit
 * without touching the existing attempt-auth type — structural typing means
 * the extra `apiKeyId` field is ignored when `runAttempt` forwards `auth` to
 * `messagesAttempt.generate`.
 *
 * Reference: Spec 10 §3.4. Pattern mirrors chat-completions/serve.ts.
 */
import { serveTemplate, type KitAuthCtx, type KitDumpSink, type KitObsCtx, type ServeTemplateHooks } from '@vibe-core/chat-flow-kit'
import type { DataPlaneAuthCtx } from '../../models/routes.ts'
import { parseMessagesPayload } from '../../parsers.ts'
import { resolveKeyModel } from '../../routing/key-model-mapping.ts'
import { kitDeps } from '../shared/kit-deps.ts'
import type { DispatchObsCtx } from '../shared/obs-ctx.ts'
import type { TelemetryRequestContext } from '../shared/telemetry-ctx.ts'
import { messagesAttempt, type MessagesAttemptAuth, type MessagesAttemptResult } from './attempt.ts'
import { respondMessages } from './respond.ts'
import type { DumpAccumulator } from '../../../shared/dump/accumulator.ts'

export interface MessagesServeArgs {
  /** Pre-parsed JSON body from http.ts (`await c.req.json()`). */
  readonly raw: unknown
  readonly auth: DataPlaneAuthCtx
  readonly obsCtx: DispatchObsCtx
  /**
   * Optional client-side abort signal (Hono's `c.req.raw.signal`). The kit
   * links this into the downstream controller so a client disconnect mid-SSE
   * cancels provider.fetch + parseMessagesStream.
   */
  readonly signal?: AbortSignal
  /** Opaque per-request dump sink (null when the api key has no retention). */
  readonly dump?: KitDumpSink | null
  /**
   * Raw client request headers. Forwarded to the attempt, which filters them
   * through the resolved provider's `inboundHeaderAllowlist` before any reach
   * the wire. Omitted ⇒ no client header is forwarded, the pre-existing
   * behaviour.
   */
  readonly inboundHeaders?: Headers
}

type MessagesPayload = Record<string, unknown> & { model: string; stream?: boolean }

type MessagesServeAuth = MessagesAttemptAuth & KitAuthCtx & Pick<DataPlaneAuthCtx, 'routingPolicy'>

const messagesHooks: ServeTemplateHooks<
  MessagesPayload,
  MessagesAttemptResult,
  undefined,
  MessagesServeAuth,
  TelemetryRequestContext
> = {
  endpointTag: 'messages',

  parse: ({ raw }) => {
    try {
      return parseMessagesPayload(raw) as MessagesPayload
    } catch (err) {
      // Re-throw with the {status, body} shape kitDeps.jsonErrorWrap consumes.
      // Default body matches the Anthropic-shaped envelope clients expect.
      const e = err as Error & { status?: number; body?: unknown }
      const wrapped = new Error(e.message) as Error & { status?: number; body?: unknown }
      wrapped.status = e.status ?? 400
      wrapped.body = e.body ?? {
        type: 'error',
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
      extra: undefined,
      ...(resolved.upstreamPin ? { authPatch: { pin: resolved.upstreamPin } } : {}),
    }
  },

  wantsStream: (p) => p.stream === true,

  runAttempt: (a) => messagesAttempt.generate({
    payload: a.payload,
    // Structural typing: extra apiKeyId on auth is ignored by attempt.
    auth: a.auth,
    // apiKeyId reaches the interceptors the same way the Responses flow does
    // (responses/serve.ts:178). The web-search shim resolves the caller's
    // engines from their key, so without it every Messages request looks like
    // it has no key and never searches.
    ctx: { requestStartedAt: a.requestStartedAt, downstreamAbortSignal: a.downstreamAbortSignal, apiKeyId: a.auth.apiKeyId },
    telemetryCtx: a.telemetryCtx,
    // `extras` is the kit's only per-request passthrough slot; the hooks object
    // is module-level and so cannot close over serveMessages' args.
    inboundHeaders: (a.extras as { inboundHeaders?: Headers }).inboundHeaders,
  }),

  respond: (r, c) => respondMessages(r, {
    wantsStream: c.wantsStream,
    downstreamAbortController: c.downstreamAbortController,
    telemetryCtx: c.telemetryCtx,
    ...(c.dump !== undefined && c.dump !== null && { dump: c.dump as DumpAccumulator }),
  }),
}

export async function serveMessages(args: MessagesServeArgs): Promise<Response> {
  const auth: MessagesServeAuth = {
    ownerId: args.auth.userId,
    copilot: args.auth.copilot,
    apiKeyId: args.auth.apiKeyId,
    routingPolicy: args.auth.routingPolicy,
  }
  const { response } = await serveTemplate(
    messagesHooks,
    { raw: args.raw, auth, obsCtx: args.obsCtx as KitObsCtx, signal: args.signal, extras: { inboundHeaders: args.inboundHeaders }, dump: args.dump ?? null },
    kitDeps,
  )
  return response
}
