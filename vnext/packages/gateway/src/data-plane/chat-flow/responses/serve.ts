import type { ResponsesLocalContinuationResolver } from "./local-continuation.ts"
import { expandShimCompactionItems } from "./interceptors/with-responses-compact-shim"
import type { CanonicalResponsesPayload } from "@vibe-llm/protocols/responses"
import { createRequestAffinity, type RequestAffinity } from "../../shared/affinity-request"
import { PerformanceRecorder } from "../../observability/performance-recorder"
// vnext/packages/gateway/src/data-plane/chat-flow/responses/serve.ts
/**
 * /v1/responses HTTP serve layer (Spec 10 — chat-flow convergence).
 *
 * The framework kit (@vibe-core/chat-flow-kit) separates preparation from
 * execution. The existing Responses turn
 * callback prepares and executes once, then owns delivery and completion.
 * This file declares the hooks and shapes auth for that handoff.
 *
 * Why preProcess? Responses must expand `previous_response_id` against the
 * responses store BEFORE binding selection (the upstream payload includes
 * the merged input history). The kit gives us a typed slot for exactly
 * this: `preProcess` runs between parse and quota, can mutate the payload,
 * and emits an `extra` value that threads through to `respond` AND the
 * wrapper's return. The extra carries immutable expanded input and the
 * request-scoped snapshot writer to the completion boundary in respond.ts.
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
  prepareTemplate,
  executeTemplate,
  type KitAuthCtx,
  type KitDumpSink,
  type KitObsCtx,
  type PrepareTemplateResult,
  type PreProcessResult,
  type ServeTemplateHooks,
} from '@vibe-core/chat-flow-kit'
import type { DataPlaneAuthCtx } from '../../models/routes.ts'
import { parseResponsesPayload } from '../../parsers.ts'
import { resolveKeyModel } from '../../routing/key-model-mapping.ts'
import { kitDeps } from '../shared/kit-deps.ts'
import type { DispatchObsCtx } from '../shared/obs-ctx.ts'
import type { TelemetryRequestContext } from '../shared/telemetry-ctx.ts'
import type { ApiKeyId, ResponsesItemId } from '../../../repo/branded-ids.ts'
import {
  appendPreviousResponseItems,
  expandPreviousResponseId,
  PreviousResponseNotFoundError,
} from '../../dispatch/responses-store-bridge.ts'
import { renderPreviousResponseNotFound } from '../../errors/forward.ts'
import { getResponsesStore } from '../../../data-plane/runtime/responses-store.ts'
import {
  responsesAttempt,
  validateResponsesAttempt,
  type ResponsesAttemptAuth,
  type ResponsesAttemptResult,
} from './attempt.ts'
import { createResponseSnapshotWriter } from './completion-snapshot.ts'
import { respondResponses, renderResponsesTurn, type ResponsesCompletionWriter } from './respond.ts'
import { createResponsesTurn, type ResponsesTurn } from './turn.ts'
import type { DumpAccumulator } from '../../../shared/dump/accumulator.ts'

export type ResponsesPreparedObserver = (
  payload: Readonly<Record<string, unknown>>,
  compactTriggered: boolean,
) => undefined

export interface ResponsesServeArgs {
  readonly localContinuation?: ResponsesLocalContinuationResolver
  readonly warmup?: boolean
  /** Keep expanded history for callers that consume the compatibility result. */
  readonly retainInputHistory?: boolean
  /** Source create state after expansion, before routing. Never an auth context. */
  readonly onPrepared?: ResponsesPreparedObserver
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
  /** Opaque per-request dump sink (null when the api key has no retention). */
  readonly dump?: KitDumpSink | null
  /**
   * Semantic verb for the request. `undefined` ≡ `'generate'`. Set to
   * `'compact'` by the `/v1/responses/compact` route so the Responses
   * compact-shim (see `interceptors/with-responses-compact-shim.ts`) detects
   * compact-shape without inspecting payload internals. When `'compact'`,
   * `wantsStream` is forced to `false` — the compact wire is synchronous
   * request/response and always renders the terminal envelope as JSON.
   */
  readonly action?: 'generate' | 'compact'
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

type ResponsesServeAuth = ResponsesAttemptAuth & KitAuthCtx & Pick<DataPlaneAuthCtx, 'routingPolicy' | 'responsesRetentionSeconds'>

type ResponsesExtra = { readonly affinity?: RequestAffinity; readonly mergedInputItems?: unknown[]; readonly incomingModel: string; readonly upstreamPin?: string; readonly onCompleted?: ResponsesCompletionWriter }

type ResponsesInputs = Pick<ResponsesServeArgs,
  'localContinuation' | 'retainInputHistory' | 'warmup' | 'onPrepared' | 'requestId' | 'userAgent' | 'action'
> & { readonly abortUpstream?: () => void }

type ResponsesPreparation = PrepareTemplateResult<ResponsesPayload, ResponsesAttemptResult, ResponsesExtra, TelemetryRequestContext, ResponsesInputs>

const responsesHooks: ServeTemplateHooks<
  ResponsesPayload,
  ResponsesAttemptResult,
  ResponsesExtra,
  ResponsesServeAuth,
  TelemetryRequestContext,
  ResponsesInputs
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
    const compactTriggered = Array.isArray(payload.input) && payload.input.some(item =>
      typeof item === 'object' && item !== null && 'type' in item && item.type === 'compaction_trigger')
    // Expand `previous_response_id` against the responses store. Mutates
    // payload.input in place (legacy contract from
    // `expandPreviousResponseId`); we read the expanded array off
    // payload.input so the snapshot writer persists the full input
    // history for the next turn.
    try {
      const resolver = ctx.extras.localContinuation
      const local = payload.previous_response_id ? resolver?.resolve(payload.previous_response_id) : undefined
      const store = getResponsesStore()
      if (local) {
        payload = { ...local.create, ...payload }
        appendPreviousResponseItems(payload, local.items)
      } else {
        if (payload.previous_response_id && (ctx.auth.responsesRetentionSeconds ?? 0) <= 0) {
          throw new PreviousResponseNotFoundError(payload.previous_response_id as ResponsesItemId)
        }
        await expandPreviousResponseId(
          payload as { previous_response_id?: string | null; input?: unknown }, store,
          (ctx.auth.apiKeyId ?? null) as ApiKeyId | null,
          payload.store !== false && (ctx.auth.responsesRetentionSeconds ?? 0) > 0
            ? ctx.auth.responsesRetentionSeconds : undefined,
        )
      }
      payload = expandShimCompactionItems(payload as unknown as CanonicalResponsesPayload) as unknown as ResponsesPayload
      const expanded = (payload as { input?: unknown }).input
      const retentionSeconds = ctx.auth.responsesRetentionSeconds ?? 0
      const onCompleted = !ctx.extras.warmup && retentionSeconds > 0 && ctx.auth.apiKeyId && payload.store !== false && ctx.extras.action !== "compact"
        ? createResponseSnapshotWriter({ store, apiKeyId: ctx.auth.apiKeyId as ApiKeyId, retentionSeconds, fallbackModel: payload.model, compactTriggered })
        : undefined
      const inputItems = Array.isArray(expanded) ? expanded : []
      const mergedInputItems = onCompleted ? structuredClone(inputItems) : ctx.extras.retainInputHistory ? inputItems : undefined
      const onPrepared = ctx.extras.onPrepared
      onPrepared?.(payload, compactTriggered)
      const resolved = resolveKeyModel(payload.model, ctx.auth.routingPolicy)
      const affinity = await createRequestAffinity("responses", { ...payload, model: resolved.routedModel }, ctx.auth)
      return {
        kind: 'continue',
        payload: { ...payload, model: resolved.routedModel },
        extra: { affinity, mergedInputItems, onCompleted, incomingModel: resolved.incomingModel, ...(resolved.upstreamPin ? { upstreamPin: resolved.upstreamPin } : {}) },
      } satisfies PreProcessResult<ResponsesPayload, ResponsesExtra>
    } catch (err) {
      // PreviousResponseNotFoundError carries only `status: 400` (no
      // body), so we MUST delegate to renderPreviousResponseNotFound to
      // preserve the OpenAI-verbatim envelope. Generic fallback (below)
      // would strip `code` + `param` and break SDK programmatic recovery.
      if (err instanceof PreviousResponseNotFoundError) {
        return {
          kind: 'short-circuit',
          response: renderPreviousResponseNotFound(err),
          extra: { mergedInputItems: [], incomingModel: payload.model },
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

  wantsStream: (p, input) =>
    // Compact wire is synchronous: force JSON regardless of caller's `stream`.
    input.extras.action === 'compact' ? false : p.stream === true,

  runAttempt: (a) => (a.extras.warmup ? validateResponsesAttempt : responsesAttempt.generate)({
    payload: a.payload,
    affinity: a.extra.affinity,
    auth: a.extra.upstreamPin ? { ...a.auth, pin: a.extra.upstreamPin } : a.auth,
    ctx: { requestStartedAt: a.requestStartedAt, downstreamAbortSignal: a.downstreamAbortSignal, apiKeyId: a.auth.apiKeyId, abortUpstream: a.extras.abortUpstream },
    dump: a.dump as DumpAccumulator | null,
    telemetryCtx: a.telemetryCtx,
    requestId: a.extras.requestId,
    userAgent: a.extras.userAgent,
    action: a.extras.action,
  }),

  respond: (r, c) => respondResponses(r, {
    wantsStream: c.wantsStream,
    affinity: c.extra.affinity?.execution,
    onCompleted: c.extra.onCompleted,
    mergedInputItems: c.extra.mergedInputItems,
    downstreamAbortController: c.downstreamAbortController,
    telemetryCtx: c.telemetryCtx,
    ...(c.dump !== undefined && c.dump !== null && { dump: c.dump as DumpAccumulator }),
  }),
}

function linkResponsesAbort(signal: AbortSignal | undefined, abortController: AbortController): () => void {
  if (!signal) return () => {}
  const onAbort = (): void => abortController.abort(signal.reason)
  if (signal.aborted) onAbort()
  else signal.addEventListener("abort", onAbort, { once: true })
  return () => signal.removeEventListener("abort", onAbort)
}

export function startResponsesTurn(args: ResponsesServeArgs): ResponsesTurn {
  const abortController = new AbortController()
  const upstreamAbortController = new AbortController()
  const unlinkAbort = linkResponsesAbort(args.signal, abortController)
  const wantsStream = args.action !== "compact" && (args.raw as { stream?: unknown } | null)?.stream === true
  const warmup = args.warmup
  const common = { wantsStream, downstreamAbortController: abortController, upstreamAbortController, finalizeDump: true, dump: args.dump as DumpAccumulator | null }
  const turn = createResponsesTurn(async () => {
    const prepared = await prepareResponses(args, upstreamAbortController)
    if (prepared.kind === "response") return { result: { kind: "bridged-response" as const, response: prepared.response }, options: common }
    const executed = await executeTemplate(prepared)
    const c = executed.context
    return { result: executed.result, options: { ...common, affinity: c.extra.affinity?.execution, onCompleted: c.extra.onCompleted, mergedInputItems: c.extra.mergedInputItems, telemetryCtx: warmup ? undefined : c.telemetryCtx } }
  }, common)
  void turn.completion.finally(unlinkAbort)
  return turn
}

async function prepareResponses(args: ResponsesServeArgs, upstreamAbortController: AbortController): Promise<ResponsesPreparation> {
  const auth: ResponsesServeAuth = {
    ownerId: args.auth.userId,
    copilot: args.auth.copilot,
    apiKeyId: args.auth.apiKeyId,
    routingPolicy: args.auth.routingPolicy,
    responsesRetentionSeconds: args.auth.responsesRetentionSeconds,
  }
  return await prepareTemplate(
    responsesHooks,
    {
      raw: args.raw,
      auth,
      obsCtx: { ...args.obsCtx, performanceRecorder: new PerformanceRecorder(false, undefined, args.obsCtx.performanceStartedAt), performanceAbortSignal: args.signal } as KitObsCtx,
      signal: upstreamAbortController.signal,
      downstreamAbortController: upstreamAbortController,
      // requestId / userAgent ride through extras so the image-gen
      // shortcut inside responsesAttempt can stamp them on upstream
      // image calls. They were dedicated args on the old serve; the
      // kit's typed side-input contract keeps these request-local values
      // separate from auth and preparation output.
      extras: { retainInputHistory: args.retainInputHistory !== false, localContinuation: args.localContinuation, warmup: args.warmup, onPrepared: args.onPrepared, requestId: args.requestId, userAgent: args.userAgent, action: args.action, abortUpstream: () => upstreamAbortController.abort() },
      dump: args.dump ?? null,
    },
    kitDeps,
  )
}

export async function serveResponses(args: ResponsesServeArgs): Promise<ResponsesServeResult> {
  const retainInputHistory = args.retainInputHistory !== false
  const turn = startResponsesTurn({ ...args, retainInputHistory })
  return { response: await renderResponsesTurn(turn), mergedInputItems: retainInputHistory ? [...turn.mergedInputItems] : [] }
}
