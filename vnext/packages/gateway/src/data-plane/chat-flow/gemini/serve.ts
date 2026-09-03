// vnext/packages/gateway/src/data-plane/chat-flow/gemini/serve.ts
/**
 * Gemini generate/stream HTTP serve layer (Spec 10 — chat-flow convergence).
 *
 * Migrated to the framework kit (@vibe-core/chat-flow-kit). Differences
 * vs the other three endpoints:
 *   - Gemini payloads do NOT carry `model` — it's URL-derived. `model` and
 *     `forceStream` (URL verb: `generateContent` vs `streamGenerateContent`)
 *     ride through `input.extras`; the hook reads them back out.
 *   - `wantsStream` reads `extras.forceStream`, NOT `payload.stream` — the
 *     client's stream intent is encoded in the URL verb, not the body.
 *   - `runAttempt` forwards both `extras.model` and `extras.forceStream` to
 *     `geminiAttempt.generate` alongside the parsed payload.
 *
 * Why the intersection auth? Same reasoning as messages/chat-completions:
 * `GeminiAttemptAuth` already declares `apiKeyId?: string`, so technically
 * `GeminiAttemptAuth & KitAuthCtx` adds nothing structurally — but we keep
 * the intersection alias for symmetry with the other three endpoints and so
 * a future change to `GeminiAttemptAuth` that drops `apiKeyId` doesn't
 * silently break the kit's quota path.
 *
 * Reference: Spec 10 §3.4. Pattern mirrors messages/serve.ts.
 */
import { serveTemplate, type KitAuthCtx, type KitDumpSink, type KitObsCtx, type ServeTemplateHooks } from '@vibe-core/chat-flow-kit'
import type { DataPlaneAuthCtx } from '../../models/routes.ts'
import { parseGeminiPayload } from '../../parsers.ts'
import { resolveKeyModel } from '../../routing/key-model-mapping.ts'
import { kitDeps } from '../shared/kit-deps.ts'
import type { DispatchObsCtx } from '../shared/obs-ctx.ts'
import type { TelemetryRequestContext } from '../shared/telemetry-ctx.ts'
import { geminiAttempt, type GeminiAttemptAuth, type GeminiAttemptResult } from './attempt.ts'
import { respondGemini } from './respond.ts'
import type { DumpAccumulator } from '../../../shared/dump/accumulator.ts'

export interface GeminiServeArgs {
  /** Pre-parsed JSON body from http.ts (`await c.req.json()`). */
  readonly raw: unknown
  /**
   * Bare model name extracted from the URL path. Gemini payloads do not carry
   * `model`, so the route handler peels it from `/v1beta/models/<model>:<verb>`.
   */
  readonly model: string
  /**
   * True when the URL verb was `streamGenerateContent` (client wants SSE).
   * False when it was `generateContent`. Threaded through attempt (so upstream
   * negotiates a stream) AND respond.ts (which decides the wire shape).
   */
  readonly forceStream: boolean
  readonly auth: DataPlaneAuthCtx
  readonly obsCtx: DispatchObsCtx
  readonly signal?: AbortSignal
  /** Opaque per-request dump sink (null when the api key has no retention). */
  readonly dump?: KitDumpSink | null
}

type GeminiPayload = Record<string, unknown> & { stream?: boolean }

type GeminiServeAuth = GeminiAttemptAuth & KitAuthCtx & Pick<DataPlaneAuthCtx, 'routingPolicy'>

const geminiHooks: ServeTemplateHooks<
  GeminiPayload,
  GeminiAttemptResult,
  undefined,
  GeminiServeAuth,
  TelemetryRequestContext
> = {
  endpointTag: 'gemini',

  parse: ({ raw }) => {
    try {
      return parseGeminiPayload(raw) as GeminiPayload
    } catch (err) {
      const e = err as Error & { status?: number; body?: unknown }
      const wrapped = new Error(e.message) as Error & { status?: number; body?: unknown }
      wrapped.status = e.status ?? 400
      wrapped.body = e.body ?? {
        error: { code: 400, message: e.message, status: 'INVALID_ARGUMENT' },
      }
      throw wrapped
    }
  },

  // forceStream lives in extras (URL-derived), not on the payload body.
  wantsStream: (_payload, input) => input.extras.forceStream === true,

  // Model is URL-derived (path param), not in the body. Keep the normalized
  // source separately so the dump always records what the caller requested.
  extractRequestedModel: (_p, input) => input.extras.requestedModel as string | undefined,

  runAttempt: (a) => geminiAttempt.generate({
    payload: { ...a.payload },
    model: a.extras.model as string,
    forceStream: a.extras.forceStream === true,
    auth: a.auth,
    ctx: { requestStartedAt: a.requestStartedAt, downstreamAbortSignal: a.downstreamAbortSignal },
    telemetryCtx: a.telemetryCtx,
  }),

  respond: (r, c) => respondGemini(r, {
    wantsStream: c.wantsStream,
    downstreamAbortController: c.downstreamAbortController,
    telemetryCtx: c.telemetryCtx,
    ...(c.dump !== undefined && c.dump !== null && { dump: c.dump as DumpAccumulator }),
  }),
}

export async function serveGemini(args: GeminiServeArgs): Promise<Response> {
  const auth: GeminiServeAuth = {
    ownerId: args.auth.userId,
    copilot: args.auth.copilot,
    apiKeyId: args.auth.apiKeyId,
    routingPolicy: args.auth.routingPolicy,
  }
  const routedModel = resolveKeyModel(args.model, args.auth.routingPolicy).routedModel
  const { response } = await serveTemplate(
    geminiHooks,
    {
      raw: args.raw,
      auth,
      obsCtx: args.obsCtx as KitObsCtx,
      signal: args.signal,
      extras: { requestedModel: args.model, model: routedModel, forceStream: args.forceStream },
      dump: args.dump ?? null,
    },
    kitDeps,
  )
  return response
}
