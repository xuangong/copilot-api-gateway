// vnext/packages/gateway/src/data-plane/chat-flow/messages/serve.ts
/**
 * Anthropic Messages HTTP serve layer (Spec 10 — chat-flow convergence).
 *
 * Migrated to the framework kit (@vnext-gateway/chat-flow-kit). The old
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
import { serveTemplate, type KitAuthCtx, type KitObsCtx, type ServeTemplateHooks } from '@vnext-gateway/chat-flow-kit'
import type { DataPlaneAuthCtx } from '../../models/routes.ts'
import { parseMessagesPayload } from '../../parsers.ts'
import { kitDeps } from '../shared/kit-deps.ts'
import type { DispatchObsCtx } from '../shared/obs-ctx.ts'
import type { TelemetryRequestContext } from '../shared/telemetry-ctx.ts'
import { messagesAttempt, type MessagesAttemptAuth, type MessagesAttemptResult } from './attempt.ts'
import { respondMessages } from './respond.ts'

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
}

type MessagesPayload = Record<string, unknown> & { model: string; stream?: boolean }

type MessagesServeAuth = MessagesAttemptAuth & KitAuthCtx

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

  wantsStream: (p) => p.stream === true,

  runAttempt: (a) => messagesAttempt.generate({
    payload: a.payload,
    // Structural typing: extra apiKeyId on auth is ignored by attempt.
    auth: a.auth,
    ctx: { requestStartedAt: a.requestStartedAt, downstreamAbortSignal: a.downstreamAbortSignal },
    telemetryCtx: a.telemetryCtx,
  }),

  respond: (r, c) => respondMessages(r, {
    wantsStream: c.wantsStream,
    downstreamAbortController: c.downstreamAbortController,
    telemetryCtx: c.telemetryCtx,
  }),
}

export async function serveMessages(args: MessagesServeArgs): Promise<Response> {
  const auth: MessagesServeAuth = {
    ownerId: args.auth.userId,
    copilot: args.auth.copilot,
    apiKeyId: args.auth.apiKeyId,
  }
  const { response } = await serveTemplate(
    messagesHooks,
    { raw: args.raw, auth, obsCtx: args.obsCtx as KitObsCtx, signal: args.signal, extras: {} },
    kitDeps,
  )
  return response
}
