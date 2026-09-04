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

/**
 * Opaque per-request sink for the request-dump pipeline (Spec 14). The kit
 * knows nothing about dump internals — it only invokes the two lifecycle
 * hooks it owns: `requestedModel` (stamped after `parse` succeeds so an
 * outright-error turn still carries model attribution) and `finalize`
 * (auto-tee'd on the returned Response so every endpoint gets the same
 * exit seam). All mid-flight calls (`frame`, `success`, `error`, `failed`,
 * `recordSentPayloadBytes`) are the respond hook's responsibility — it
 * receives the same object via `RespondCtx.dump` and can cast to the
 * concrete accumulator type it imported.
 */
export interface KitDumpSink {
  requestedModel(model: string): void
  finalize(response: Response): Response
}

export interface ServeTemplateInput<TAuth extends KitAuthCtx = KitAuthCtx> {
  readonly raw: unknown
  readonly auth: TAuth
  readonly obsCtx: KitObsCtx
  readonly signal?: AbortSignal
  /** Catch-all bag for endpoint-specific side inputs (e.g. URL-derived
   *  model name + verb, or per-request passthrough fields). Opaque to the kit. */
  readonly extras: Record<string, unknown>
  /** Opaque request-dump sink. When present, the kit calls
   *  `requestedModel` after `parse` and `finalize` on the returned
   *  Response; respond hooks pick it up off `RespondCtx.dump`. Null when
   *  the api key has no retention configured. */
  readonly dump?: KitDumpSink | null
}

export interface PreProcessCtx<TAuth extends KitAuthCtx = KitAuthCtx> {
  readonly auth: TAuth
}

/** preProcess returns one of two shapes: continue with a (possibly mutated)
 *  payload + extra, OR short-circuit with a Response. The kit never permits
 *  preprocessing to modify the auth context; endpoint-specific routing data
 *  belongs in `extra`. The short-circuit branch lets endpoints render bespoke
 *  error envelopes (e.g. domain-specific
 *  not-found shapes) without the kit knowing their wire shape. */
export type PreProcessResult<TPayload, TExtra> =
  | { kind: 'continue'; payload: TPayload; extra: TExtra }
  | { kind: 'short-circuit'; response: Response; extra: TExtra }

export interface RunAttemptArgs<TPayload, TExtra, TAuth, TTelemetryCtx> {
  readonly payload: TPayload
  /** Endpoint-specific data returned by preProcess. This carries routing data
   * without allowing preprocessing to alter the request auth context. */
  readonly extra: TExtra | undefined
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
  /** Opaque dump sink threaded from `ServeTemplateInput.dump`. Respond
   *  hooks cast this to the concrete accumulator type they imported and
   *  call `frame`/`success`/`error`/`recordSentPayloadBytes` in-flight. */
  readonly dump?: KitDumpSink | null
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

  /** Optional: extract the requested model id from the parsed payload so
   *  the kit can stamp it onto the dump sink immediately after `parse`.
   *  Endpoints that carry the model in the URL (Gemini) or on a different
   *  field can override; default (unspecified) is to read `.model`. */
  extractRequestedModel?(payload: TPayload, input: ServeTemplateInput<TAuth>): string | undefined

  /** Optional renderer for parse() failures. Default: `deps.jsonErrorWrap`. */
  parseErrorRender?(err: Error & { status?: number; body?: unknown }): Response

  preProcess?(
    payload: TPayload,
    ctx: PreProcessCtx<TAuth>,
  ): Promise<PreProcessResult<TPayload, TExtra>>

  wantsStream(payload: TPayload, input: ServeTemplateInput<TAuth>): boolean

  runAttempt(args: RunAttemptArgs<TPayload, TExtra, TAuth, TTelemetryCtx>): Promise<TAttemptResult>

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
    const errResp = render(e)
    return { response: input.dump ? input.dump.finalize(errResp) : errResp, extra: undefined }
  }

  // 1b. Stamp the requested model onto the dump sink as soon as parse
  //     succeeds, so a downstream error still carries model attribution.
  if (input.dump) {
    const model = hooks.extractRequestedModel
      ? hooks.extractRequestedModel(payload, input)
      : (payload as { model?: unknown } | null)?.model
    if (typeof model === 'string' && model.length > 0) input.dump.requestedModel(model)
  }

  // 2. preProcess (optional).
  let extra: TExtra | undefined
  if (hooks.preProcess) {
    let pre: PreProcessResult<TPayload, TExtra>
    try {
      pre = await hooks.preProcess(payload, { auth: input.auth })
    } catch (err) {
      const e = err as Error & { status?: number; body?: unknown }
      const errResp = deps.jsonErrorWrap(e.status ?? 400, e.body ?? { error: { message: e.message } })
      return {
        response: input.dump ? input.dump.finalize(errResp) : errResp,
        extra: undefined,
      }
    }
    if (pre.kind === 'short-circuit') {
      return { response: input.dump ? input.dump.finalize(pre.response) : pre.response, extra: pre.extra }
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
  if (quotaResp) return { response: input.dump ? input.dump.finalize(quotaResp) : quotaResp, extra }

  // 6. Linked AbortController.
  const controller = new AbortController()
  if (input.signal) {
    if (input.signal.aborted) controller.abort()
    else input.signal.addEventListener('abort', () => controller.abort(), { once: true })
  }

  // 7. runAttempt.
  const result = await hooks.runAttempt({
    payload,
    extra,
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
    dump: input.dump ?? null,
  })

  // 9. Auto-tee the terminal Response into the dump sink so every
  //    endpoint gets the same exit seam. Respond hooks handle the
  //    mid-flight frame/success/error calls themselves.
  const finalResponse = input.dump ? input.dump.finalize(response) : response

  // 10. return.
  return { response: finalResponse, extra }
}
