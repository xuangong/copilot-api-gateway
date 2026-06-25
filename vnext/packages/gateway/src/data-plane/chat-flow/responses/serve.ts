// vnext/packages/gateway/src/data-plane/chat-flow/responses/serve.ts
/**
 * /v1/responses HTTP serve layer (Spec 10 — chat-flow convergence).
 *
 * Migrated to the framework kit (@vibe-core/chat-flow-kit). The legacy
 * inline pipeline (parse → expandPreviousResponseId → telemetry → quota →
 * controller → attempt → respond) now flows through `serveTemplate(...)`;
 * this file declares the hooks, shapes auth, and maps the kit result back
 * to the existing `ResponsesServeResult` shape so `responses/http.ts`
 * keeps its `{ response, mergedInputItems } = await serveResponses(...)`
 * destructuring unchanged.
 *
 * Why preProcess? Responses must expand `previous_response_id` against the
 * responses store BEFORE binding selection (the upstream payload includes
 * the merged input history). The kit gives us a typed slot for exactly
 * this: `preProcess` runs between parse and quota, can mutate the payload,
 * and emits an `extra` value that threads through to `respond` AND the
 * wrapper's return. We use `extra = { mergedInputItems }` so http.ts can
 * persist the full input history in the snapshot sidecar.
 *
 * Why short-circuit on PreviousResponseNotFoundError? The OpenAI-verbatim
 * envelope (`code: 'previous_response_not_found'`, `param:
 * 'previous_response_id'`) is preserved by delegating to
 * `renderPreviousResponseNotFound(err)` — `jsonErrorWrap` strips those
 * fields and would break programmatic recovery for SDKs.
 *
 * Why the intersection auth? `ResponsesAttemptAuth` already has an
 * optional `apiKeyId`, but we keep the explicit intersection
 * (`ResponsesServeAuth = ResponsesAttemptAuth & KitAuthCtx`) for symmetry
 * with the other three endpoints and to defend against future drift if
 * either type loses the field.
 *
 * Reference: Spec 10 §3.3 (preProcess), §3.4 (responses notes).
 */
import {
  serveTemplate,
  type KitAuthCtx,
  type KitObsCtx,
  type PreProcessResult,
  type ServeTemplateHooks,
} from '@vibe-core/chat-flow-kit'
import type { DataPlaneAuthCtx } from '../../models/routes.ts'
import { parseResponsesPayload } from '../../parsers.ts'
import { kitDeps } from '../shared/kit-deps.ts'
import type { DispatchObsCtx } from '../shared/obs-ctx.ts'
import type { TelemetryRequestContext } from '../shared/telemetry-ctx.ts'
import {
  expandPreviousResponseId,
  PreviousResponseNotFoundError,
} from '../../dispatch/responses-store-bridge.ts'
import { renderPreviousResponseNotFound } from '../../errors/repackage.ts'
import { getResponsesStore } from '../../../shared/runtime/responses-store.ts'
import {
  responsesAttempt,
  type ResponsesAttemptAuth,
  type ResponsesAttemptResult,
} from './attempt.ts'
import { respondResponses } from './respond.ts'

export interface ResponsesServeArgs {
  /** Pre-parsed JSON body from http.ts (`await c.req.json()`). */
  readonly raw: unknown
  readonly auth: DataPlaneAuthCtx
  readonly obsCtx: DispatchObsCtx
  /** Optional client-side abort signal (Hono's `c.req.raw.signal`). */
  readonly signal?: AbortSignal
  /** Optional request id passthrough so attempt.ts can stamp it on shortcut upstream calls. */
  readonly requestId?: string
  /** Optional User-Agent passthrough so attempt.ts can echo it into shortcut upstream calls. */
  readonly userAgent?: string
}

export interface ResponsesServeResult {
  readonly response: Response
  readonly mergedInputItems: unknown[]
}

type ResponsesPayload = Record<string, unknown> & {
  model: string
  stream?: boolean
  input?: unknown
  tools?: unknown
  previous_response_id?: string | null
}

type ResponsesServeAuth = ResponsesAttemptAuth & KitAuthCtx

type ResponsesExtra = { readonly mergedInputItems: unknown[] }

const responsesHooks: ServeTemplateHooks<
  ResponsesPayload,
  ResponsesAttemptResult,
  ResponsesExtra,
  ResponsesServeAuth,
  TelemetryRequestContext
> = {
  endpointTag: 'responses',

  parse: ({ raw }) => {
    try {
      return parseResponsesPayload(raw) as ResponsesPayload
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
    // Expand `previous_response_id` against the responses store. Mutates
    // payload.input in place (legacy contract from
    // `expandPreviousResponseId`); we read the expanded array off
    // payload.input so the snapshot sidecar persists the full input
    // history for the next turn.
    try {
      const store = getResponsesStore()
      await expandPreviousResponseId(
        payload as { previous_response_id?: string | null; input?: unknown },
        store,
        ctx.auth.apiKeyId ?? null,
      )
      const expanded = (payload as { input?: unknown }).input
      const mergedInputItems = Array.isArray(expanded) ? (expanded as unknown[]) : []
      return { kind: 'continue', payload, extra: { mergedInputItems } } satisfies PreProcessResult<
        ResponsesPayload,
        ResponsesExtra
      >
    } catch (err) {
      // PreviousResponseNotFoundError carries only `status: 400` (no
      // body), so we MUST delegate to renderPreviousResponseNotFound to
      // preserve the OpenAI-verbatim envelope. Generic fallback (below)
      // would strip `code` + `param` and break SDK programmatic recovery.
      if (err instanceof PreviousResponseNotFoundError) {
        return {
          kind: 'short-circuit',
          response: renderPreviousResponseNotFound(err),
          extra: { mergedInputItems: [] },
        } satisfies PreProcessResult<ResponsesPayload, ResponsesExtra>
      }
      // Any other expansion failure → re-throw with the {status, body}
      // shape `deps.jsonErrorWrap` consumes (kit's preProcess fallback
      // calls jsonErrorWrap exactly like parse).
      const e = err as Error & { status?: number; body?: unknown }
      const wrapped = new Error(e.message) as Error & { status?: number; body?: unknown }
      wrapped.status = e.status ?? 400
      wrapped.body = e.body ?? {
        error: { type: 'invalid_request_error', message: e.message },
      }
      throw wrapped
    }
  },

  wantsStream: (p) => p.stream === true,

  runAttempt: (a) => responsesAttempt.generate({
    payload: a.payload,
    auth: a.auth,
    ctx: { requestStartedAt: a.requestStartedAt, downstreamAbortSignal: a.downstreamAbortSignal },
    telemetryCtx: a.telemetryCtx,
    requestId: (a.extras.requestId as string | undefined),
    userAgent: (a.extras.userAgent as string | undefined),
  }),

  respond: (r, c) => respondResponses(r, {
    wantsStream: c.wantsStream,
    downstreamAbortController: c.downstreamAbortController,
    telemetryCtx: c.telemetryCtx,
  }),
}

export async function serveResponses(args: ResponsesServeArgs): Promise<ResponsesServeResult> {
  const auth: ResponsesServeAuth = {
    ownerId: args.auth.userId,
    copilot: args.auth.copilot,
    apiKeyId: args.auth.apiKeyId,
  }
  const { response, extra } = await serveTemplate(
    responsesHooks,
    {
      raw: args.raw,
      auth,
      obsCtx: args.obsCtx as KitObsCtx,
      signal: args.signal,
      // requestId / userAgent ride through extras so the image-gen
      // shortcut inside responsesAttempt can stamp them on upstream
      // image calls. They were dedicated args on the old serve; the
      // kit's RunAttemptArgs only standardises payload/auth/telemetry,
      // so per-endpoint passthroughs live in `extras`.
      extras: { requestId: args.requestId, userAgent: args.userAgent },
    },
    kitDeps,
  )
  return { response, mergedInputItems: extra?.mergedInputItems ?? [] }
}
