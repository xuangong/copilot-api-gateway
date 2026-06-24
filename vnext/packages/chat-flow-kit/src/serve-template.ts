// vnext/packages/chat-flow-kit/src/serve-template.ts
/**
 * Domain-neutral chat-flow serve template.
 *
 * The kit knows nothing about LLM endpoints, binding kinds, or protocol
 * literals. Callers (the LLM gateway adapter) declare endpoint-specific
 * hooks and inject env-touching collaborators via `ServeTemplateDeps`.
 *
 * Spec: vnext/docs/superpowers/specs/2026-06-24-spec10-chat-flow-convergence.md
 */

/** Minimal auth shape the kit itself reads. Adapters pass a richer
 *  `TAuth extends KitAuthCtx` (typically `<Endpoint>AttemptAuth & KitAuthCtx`)
 *  that they shape into the attempt's expected auth (e.g. `userId → ownerId`)
 *  BEFORE calling `serveTemplate`. The kit only reads `apiKeyId` for quota +
 *  telemetry, then forwards the whole object to `runAttempt`. */
export interface KitAuthCtx {
  /** Optional per-key id used for quota lookup and telemetry tagging. */
  readonly apiKeyId?: string | null
}

export interface KitObsCtx {
  readonly apiKeyId?: string | null
  readonly userAgent?: string | null
  readonly requestId?: string | null
  readonly [extra: string]: unknown
}

export interface ServeTemplateInput<TAuth extends KitAuthCtx = KitAuthCtx> {
  readonly raw: unknown
  readonly auth: TAuth
  readonly obsCtx: KitObsCtx
  readonly signal?: AbortSignal
  /** Catch-all bag for endpoint-specific side inputs (gemini model/verb,
   *  responses requestId/userAgent passthrough). Opaque to the kit. */
  readonly extras: Record<string, unknown>
}

export interface PreProcessCtx<TAuth extends KitAuthCtx = KitAuthCtx> {
  readonly auth: TAuth
}

/** preProcess returns one of two shapes: continue with a (possibly mutated)
 *  payload + extra, OR short-circuit with a Response. The short-circuit branch
 *  lets endpoints render bespoke error envelopes (e.g. responses'
 *  previous_response_not_found) without the kit knowing their wire shape. */
export type PreProcessResult<TPayload, TExtra> =
  | { kind: 'continue'; payload: TPayload; extra: TExtra }
  | { kind: 'short-circuit'; response: Response; extra: TExtra }

export interface RunAttemptArgs<TPayload, TAuth, TTelemetryCtx> {
  readonly payload: TPayload
  readonly auth: TAuth
  readonly telemetryCtx: TTelemetryCtx
  readonly downstreamAbortSignal: AbortSignal
  readonly requestStartedAt: number
  readonly extras: Record<string, unknown>
}

export interface RespondCtx<TPayload, TExtra, TTelemetryCtx> {
  readonly payload: TPayload
  readonly extra: TExtra
  readonly wantsStream: boolean
  readonly downstreamAbortController: AbortController
  readonly telemetryCtx: TTelemetryCtx
  readonly extras: Record<string, unknown>
}

export interface ServeTemplateHooks<
  TPayload,
  TAttemptResult,
  TExtra = undefined,
  TAuth extends KitAuthCtx = KitAuthCtx,
  TTelemetryCtx = unknown,
> {
  /** Caller-supplied tag. Opaque to the kit; only `deps.buildTelemetryCtx`
   *  receives it. Keeps the purity gate intact (no LLM literals in the kit). */
  readonly endpointTag: string

  parse(input: ServeTemplateInput<TAuth>): Promise<TPayload> | TPayload

  /** Optional renderer for parse() failures. Default: `deps.jsonErrorWrap`. */
  parseErrorRender?(err: Error & { status?: number; body?: unknown }): Response

  preProcess?(
    payload: TPayload,
    ctx: PreProcessCtx<TAuth>,
  ): Promise<PreProcessResult<TPayload, TExtra>>

  wantsStream(payload: TPayload, input: ServeTemplateInput<TAuth>): boolean

  runAttempt(args: RunAttemptArgs<TPayload, TAuth, TTelemetryCtx>): Promise<TAttemptResult>

  respond(
    result: TAttemptResult,
    ctx: RespondCtx<TPayload, TExtra, TTelemetryCtx>,
  ): Promise<Response>
}

export interface ServeTemplateDeps<TAuth extends KitAuthCtx, TTelemetryCtx> {
  readonly runQuotaGate: (apiKeyId: string | null | undefined) => Promise<Response | null>
  readonly jsonErrorWrap: (status: number, body: unknown) => Response
  readonly buildTelemetryCtx: (input: {
    auth: TAuth
    obsCtx: KitObsCtx
    isStreaming: boolean
    requestStartedAt: number
    endpointTag: string
  }) => TTelemetryCtx
}

export interface ServeTemplateResult<TExtra> {
  readonly response: Response
  readonly extra: TExtra | undefined
}

export async function serveTemplate<
  TPayload,
  TAttemptResult,
  TExtra = undefined,
  TAuth extends KitAuthCtx = KitAuthCtx,
  TTelemetryCtx = unknown,
>(
  hooks: ServeTemplateHooks<TPayload, TAttemptResult, TExtra, TAuth, TTelemetryCtx>,
  input: ServeTemplateInput<TAuth>,
  deps: ServeTemplateDeps<TAuth, TTelemetryCtx>,
): Promise<ServeTemplateResult<TExtra>> {
  const requestStartedAt = Date.now()

  // 1. Parse.
  let payload: TPayload
  try {
    payload = await hooks.parse(input)
  } catch (err) {
    const e = err as Error & { status?: number; body?: unknown }
    const render = hooks.parseErrorRender ?? ((x: typeof e) => deps.jsonErrorWrap(x.status ?? 400, x.body ?? { error: { message: x.message } }))
    return { response: render(e), extra: undefined }
  }

  // 2. preProcess (optional).
  let extra: TExtra | undefined
  if (hooks.preProcess) {
    let pre: PreProcessResult<TPayload, TExtra>
    try {
      pre = await hooks.preProcess(payload, { auth: input.auth })
    } catch (err) {
      const e = err as Error & { status?: number; body?: unknown }
      return {
        response: deps.jsonErrorWrap(e.status ?? 400, e.body ?? { error: { message: e.message } }),
        extra: undefined,
      }
    }
    if (pre.kind === 'short-circuit') {
      return { response: pre.response, extra: pre.extra }
    }
    payload = pre.payload
    extra = pre.extra
  }

  // 3. wantsStream.
  const wantsStream = hooks.wantsStream(payload, input)

  // 4. buildTelemetryCtx.
  const telemetryCtx = deps.buildTelemetryCtx({
    auth: input.auth,
    obsCtx: input.obsCtx,
    isStreaming: wantsStream,
    requestStartedAt,
    endpointTag: hooks.endpointTag,
  })

  // 5. quota gate.
  const quotaResp = await deps.runQuotaGate(input.auth.apiKeyId)
  if (quotaResp) return { response: quotaResp, extra }

  // 6. Linked AbortController.
  const controller = new AbortController()
  if (input.signal) {
    if (input.signal.aborted) controller.abort()
    else input.signal.addEventListener('abort', () => controller.abort(), { once: true })
  }

  // 7. runAttempt.
  const result = await hooks.runAttempt({
    payload,
    auth: input.auth,
    telemetryCtx,
    downstreamAbortSignal: controller.signal,
    requestStartedAt,
    extras: input.extras,
  })

  // 8. respond.
  const response = await hooks.respond(result, {
    payload,
    extra: extra as TExtra,
    wantsStream,
    downstreamAbortController: controller,
    telemetryCtx,
    extras: input.extras,
  })

  // 9. return.
  return { response, extra }
}
