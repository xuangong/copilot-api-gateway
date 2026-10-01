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

/** Canonical producers retain frame ownership until metadata observation
 * settles. Transport byte accounting never needs a second body consumer. */
export interface KitCanonicalCompletion {
  readonly settled: Promise<void>
  /** Synchronously hand off available dump scalars and interrupt semantic observation on cancellation. */
  cancel?(): void
  /** Already serialized JSON, used only if the canonical source had no frames. */
  readonly fallbackBody?: string
}

const canonicalResponses = new WeakMap<Response, KitCanonicalCompletion>()

export function withCanonicalCompletion(response: Response, completion: KitCanonicalCompletion): Response {
  canonicalResponses.set(response, completion)
  return response
}

export interface KitDumpSink {
  requestedModel(model: string): void
  finalize(response: Response, completion?: KitCanonicalCompletion): Response
  /** Release an exceptional exit before a response exists. The concrete sink
   * owns already-started preparation and any selected terminal persistence. */
  abandon?(): void | Promise<void>
}

/** Diagnostic cleanup must preserve the original exception and must not make
 * its propagation wait for background preparation or persistence. */
export function withDumpExceptionCleanup<T>(
  dump: Pick<KitDumpSink, 'abandon'> | null | undefined,
  work: () => Promise<T>,
): Promise<T> {
  if (!dump?.abandon) return work()
  return (async () => {
    try { return await work() }
    catch (error) {
      try { void Promise.resolve(dump.abandon?.()).catch(() => {}) }
      catch { /* Cleanup cannot replace the request's exception. */ }
      throw error
    }
  })()
}

export interface ServeTemplateInput<TAuth extends KitAuthCtx = KitAuthCtx, TInputs = Record<string, unknown>> {
  readonly raw: unknown
  readonly auth: TAuth
  readonly obsCtx: KitObsCtx
  readonly signal?: AbortSignal
  /** Optional endpoint-owned cancellation controller; avoids a second link. */
  readonly downstreamAbortController?: AbortController
  /** Typed endpoint-specific side inputs, opaque to the kit. */
  readonly extras: TInputs
  /** Opaque request-dump sink. When present, the kit calls
   *  `requestedModel` after `parse` and `finalize` with an optional canonical
   *  completion on the returned Response. Null when
   *  the api key has no retention configured. */
  readonly dump?: KitDumpSink | null
}

export interface PreProcessCtx<TAuth extends KitAuthCtx = KitAuthCtx, TInputs = Record<string, unknown>> {
  readonly auth: TAuth
  /** Endpoint-owned input side data. Opaque to the kit, such as URL-derived model names. */
  readonly extras: TInputs
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

export interface RunAttemptArgs<TPayload, TExtra, TAuth, TTelemetryCtx, TInputs = Record<string, unknown>> {
  readonly dump?: KitDumpSink | null
  readonly payload: TPayload
  /** Endpoint-specific data returned by preProcess. This carries routing data
   * without allowing preprocessing to alter the request auth context. */
  readonly extra: TExtra | undefined
  readonly auth: TAuth
  readonly telemetryCtx: TTelemetryCtx
  readonly downstreamAbortSignal: AbortSignal
  readonly requestStartedAt: number
  readonly extras: TInputs
}

export interface RespondCtx<TPayload, TExtra, TTelemetryCtx, TInputs = Record<string, unknown>> {
  readonly payload: TPayload
  readonly extra: TExtra | undefined
  readonly wantsStream: boolean
  readonly downstreamAbortController: AbortController
  readonly telemetryCtx: TTelemetryCtx
  readonly extras: TInputs
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
  TInputs = Record<string, unknown>,
> {
  /** Caller-supplied tag. Opaque to the kit; only `deps.buildTelemetryCtx`
   *  receives it. Keeps the purity gate intact (no LLM literals in the kit). */
  readonly endpointTag: string

  parse(input: ServeTemplateInput<TAuth, TInputs>): Promise<TPayload> | TPayload

  /** Optional: extract the requested model id from the parsed payload so
   *  the kit can stamp it onto the dump sink immediately after `parse`.
   *  Endpoints that carry the model in the URL (Gemini) or on a different
   *  field can override; default (unspecified) is to read `.model`. */
  extractRequestedModel?(payload: TPayload, input: ServeTemplateInput<TAuth, TInputs>): string | undefined

  /** Optional renderer for parse() failures. Default: `deps.jsonErrorWrap`. */
  parseErrorRender?(err: Error & { status?: number; body?: unknown }): Response

  preProcess?(
    payload: TPayload,
    ctx: PreProcessCtx<TAuth, TInputs>,
  ): Promise<PreProcessResult<TPayload, TExtra>>

  wantsStream(payload: TPayload, input: ServeTemplateInput<TAuth, TInputs>): boolean

  runAttempt(args: RunAttemptArgs<TPayload, TExtra, TAuth, TTelemetryCtx, TInputs>): Promise<TAttemptResult>

  respond(
    result: TAttemptResult,
    ctx: RespondCtx<TPayload, TExtra, TTelemetryCtx, TInputs>,
  ): Promise<Response>
}

export interface BuildTelemetryCtxArgs<TPayload = unknown, TExtra = unknown, TAuth extends KitAuthCtx = KitAuthCtx> {
  readonly auth: TAuth
  readonly obsCtx: KitObsCtx
  readonly payload: TPayload
  readonly extra: TExtra | undefined
  readonly isStreaming: boolean
  readonly requestStartedAt: number
  readonly endpointTag: string
}

export interface ServeTemplateDeps<
  TAuth extends KitAuthCtx,
  TTelemetryCtx,
  TPayload = unknown,
  TExtra = unknown,
> {
  readonly runQuotaGate: (apiKeyId: string | null | undefined) => Promise<Response | null>
  readonly jsonErrorWrap: (status: number, body: unknown) => Response
  readonly buildTelemetryCtx: (input: BuildTelemetryCtxArgs<TPayload, TExtra, TAuth>) => TTelemetryCtx
}

export interface ServeTemplateResult<TExtra> {
  readonly response: Response
  readonly extra: TExtra | undefined
}

const executionCapability = Symbol("prepared execution")

export interface ExecuteTemplateResult<TPayload, TAttemptResult, TExtra = undefined, TTelemetryCtx = unknown, TInputs = Record<string, unknown>> {
  readonly result: TAttemptResult
  readonly context: RespondCtx<TPayload, TExtra, TTelemetryCtx, TInputs>
  readonly extra: TExtra | undefined
}

export interface ReadyTemplateResult<TPayload, TAttemptResult, TExtra = undefined, TTelemetryCtx = unknown, TInputs = Record<string, unknown>> {
  readonly kind: 'ready'
  readonly context: RespondCtx<TPayload, TExtra, TTelemetryCtx, TInputs>
  readonly extra: TExtra | undefined
  readonly [executionCapability]: () => Promise<ExecuteTemplateResult<TPayload, TAttemptResult, TExtra, TTelemetryCtx, TInputs>>
}

export type PrepareTemplateResult<TPayload, TAttemptResult, TExtra = undefined, TTelemetryCtx = unknown, TInputs = Record<string, unknown>> =
  | { readonly kind: 'response'; readonly response: Response; readonly extra: TExtra | undefined }
  | ReadyTemplateResult<TPayload, TAttemptResult, TExtra, TTelemetryCtx, TInputs>

// A live cancellation listener must not retain the prepared request graph.
function linkInboundAbort(signal: AbortSignal | undefined, controller: AbortController): void {
  if (signal && signal !== controller.signal) {
    if (signal.aborted) controller.abort(signal.reason)
    else signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true })
  }
}

// Keep the ready handoff independent of raw input and preparation dependencies.
function createReadyTemplate<TPayload, TAttemptResult, TExtra, TAuth, TTelemetryCtx, TInputs>(
  runner: (args: RunAttemptArgs<TPayload, TExtra, TAuth, TTelemetryCtx, TInputs>) => Promise<TAttemptResult>,
  args: RunAttemptArgs<TPayload, TExtra, TAuth, TTelemetryCtx, TInputs>,
  context: RespondCtx<TPayload, TExtra, TTelemetryCtx, TInputs>,
  signal: AbortSignal | undefined,
): ReadyTemplateResult<TPayload, TAttemptResult, TExtra, TTelemetryCtx, TInputs> {
  let pendingRunner: typeof runner | undefined = runner
  return {
    kind: 'ready', context, extra: context.extra,
    [executionCapability]: async () => {
      const run = pendingRunner
      if (!run) throw new Error('Prepared execution has already been consumed')
      pendingRunner = undefined
      linkInboundAbort(signal, context.downstreamAbortController)
      const result = await run(args)
      return { result, context, extra: context.extra }
    },
  }
}

export function executeTemplate<TPayload, TAttemptResult, TExtra = undefined, TTelemetryCtx = unknown, TInputs = Record<string, unknown>>(
  ready: ReadyTemplateResult<TPayload, TAttemptResult, TExtra, TTelemetryCtx, TInputs>,
): Promise<ExecuteTemplateResult<TPayload, TAttemptResult, TExtra, TTelemetryCtx, TInputs>> {
  return ready[executionCapability]()
}

export async function prepareTemplate<
  TPayload,
  TAttemptResult,
  TExtra = undefined,
  TAuth extends KitAuthCtx = KitAuthCtx,
  TTelemetryCtx = unknown,
  TInputs = Record<string, unknown>,
>(
  hooks: ServeTemplateHooks<TPayload, TAttemptResult, TExtra, TAuth, TTelemetryCtx, TInputs>,
  input: ServeTemplateInput<TAuth, TInputs>,
  deps: ServeTemplateDeps<TAuth, TTelemetryCtx, TPayload, TExtra>,
): Promise<PrepareTemplateResult<TPayload, TAttemptResult, TExtra, TTelemetryCtx, TInputs>> {
  const requestStartedAt = Date.now()

  // 1. Parse.
  let payload: TPayload
  try {
    payload = await hooks.parse(input)
  } catch (err) {
    const e = err as Error & { status?: number; body?: unknown }
    const render = hooks.parseErrorRender ?? ((x: typeof e) => deps.jsonErrorWrap(x.status ?? 400, x.body ?? { error: { message: x.message } }))
    const errResp = render(e)
    return { kind: 'response', response: errResp, extra: undefined }
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
      pre = await hooks.preProcess(payload, { auth: input.auth, extras: input.extras })
    } catch (err) {
      const e = err as Error & { status?: number; body?: unknown }
      const errResp = deps.jsonErrorWrap(e.status ?? 400, e.body ?? { error: { message: e.message } })
      return {
        kind: 'response', response: errResp,
        extra: undefined,
      }
    }
    if (pre.kind === 'short-circuit') {
      return { kind: 'response', response: pre.response, extra: pre.extra }
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
    payload,
    extra,
    isStreaming: wantsStream,
    requestStartedAt,
    endpointTag: hooks.endpointTag,
  })

  // 5. quota gate.
  const quotaResp = await deps.runQuotaGate(input.auth.apiKeyId)
  if (quotaResp) return { kind: 'response', response: quotaResp, extra }

  const controller = input.downstreamAbortController ?? new AbortController()
  const context: RespondCtx<TPayload, TExtra, TTelemetryCtx, TInputs> = {
    payload, extra, wantsStream, downstreamAbortController: controller,
    telemetryCtx, extras: input.extras, dump: input.dump ?? null,
  }
  return createReadyTemplate(hooks.runAttempt.bind(hooks), {
    dump: input.dump ?? null,
    payload,
    extra,
    auth: input.auth,
    telemetryCtx,
    downstreamAbortSignal: controller.signal,
    requestStartedAt,
    extras: input.extras,
  }, context, input.signal)
}

export async function serveTemplate<TPayload, TAttemptResult, TExtra = undefined, TAuth extends KitAuthCtx = KitAuthCtx, TTelemetryCtx = unknown, TInputs = Record<string, unknown>>(
  hooks: ServeTemplateHooks<TPayload, TAttemptResult, TExtra, TAuth, TTelemetryCtx, TInputs>,
  input: ServeTemplateInput<TAuth, TInputs>,
  deps: ServeTemplateDeps<TAuth, TTelemetryCtx, TPayload, TExtra>,
): Promise<ServeTemplateResult<TExtra>> {
  return withDumpExceptionCleanup(input.dump, async () => {
    const prepared = await prepareTemplate(hooks, input, deps)
    let response: Response
    if (prepared.kind === 'response') response = prepared.response
    else {
      const executed = await executeTemplate(prepared)
      response = await hooks.respond(executed.result, executed.context)
    }
    const completion = canonicalResponses.get(response)
    canonicalResponses.delete(response)
    return { response: input.dump ? input.dump.finalize(response, completion) : response, extra: prepared.extra }
  })
}
