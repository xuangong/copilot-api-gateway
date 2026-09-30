import { disposeEventProducerBody } from "../shared/producer-ownership"
import { AffinityEgress, guardAffinityFrames } from "../../../shared/affinity/egress"
import type { AffinityExecutionState } from "../../shared/affinity-request"
import { StreamTail, closeStream, settleStreamMetadata } from "../shared/stream-tail"
import { parseSSEStream } from "@vibe-core/result/parse"
import { waitUntil } from "@vibe-core/platform"
import { eventFrame, type ProtocolFrame } from "@vibe-core/result"
import { upstreamErrorToResponse, type LlmEventResult, type LlmExecuteResult, type EventResultMetadata } from "@vibe-llm/protocols/common"
import { ResponsesFinalOutput, type ResponsesStreamEvent } from "@vibe-llm/protocols/responses"
import { forwardUpstreamError } from "../../errors/forward"
import { SourceStreamState, eventResultMetadata, finalModelIdentity, normalizeStreamEventModel, performanceTargetFromTranslatorPair, recordPerformance, recordUsage } from "../shared/respond-telemetry"
import type { TelemetryRequestContext } from "../shared/telemetry-ctx"
import type { DumpAccumulator } from "../../../shared/dump/accumulator"
import { prepareResponsesSource } from "./source-result"

export interface CompletedResponsesSnapshot {
  readonly id: string
  readonly model?: string
  readonly output: unknown[]
}

export type ResponsesCompletionWriter = (response: CompletedResponsesSnapshot, inputItems: readonly unknown[]) => Promise<void>

export interface ResponsesTurnOptions {
  readonly affinity?: AffinityExecutionState
  readonly onCompleted?: ResponsesCompletionWriter
  readonly mergedInputItems?: readonly unknown[]
  readonly wantsStream: boolean
  readonly upstreamAbortController?: AbortController
  readonly finalizeDump?: boolean
  /** Linked controller for downstream client cancel; same plumbing as messages. */
  readonly downstreamAbortController?: AbortController
  /** Optional — when provided, respond.ts persists usage + perf rows. */
  readonly telemetryCtx?: TelemetryRequestContext
  /** Optional per-request dump accumulator. */
  readonly dump?: DumpAccumulator | null
}

/**
 * Mirrors {@link ResponsesAttemptResult} from `./attempt.ts`. Declared inline
 * so this module stays decoupled from the attempt surface — the union is part
 * of the chat-flow public contract, not the leaf's implementation.
 */
export type RespondResponsesInput =
  | LlmExecuteResult<ProtocolFrame<ResponsesStreamEvent>>
  | { readonly kind: 'bridged-response'; readonly response: Response }

const SNAPSHOT_FAILURE = "Unable to persist response continuation state."

const reusableResponse = (body: unknown): body is CompletedResponsesSnapshot => {
  if (!body || typeof body !== "object") return false
  const response = body as Record<string, unknown>
  return typeof response.id === "string" && response.id.length > 0 && Array.isArray(response.output)
    && (response.status === "completed" || response.status === undefined)
    && !response.error && !response.incomplete_details
}

async function persistCompleted(body: unknown, options: ResponsesTurnOptions, trackSave: (save: Promise<void>) => void): Promise<void> {
  const signal = options.downstreamAbortController?.signal
  if (signal?.aborted) throw new Error("Response cancelled.")
  const { onCompleted, mergedInputItems = [] } = options
  if (!onCompleted || !reusableResponse(body)) return
  const save = Promise.resolve().then(() => onCompleted(body, mergedInputItems))
  trackSave(save)
  let onAbort: (() => void) | undefined
  try {
    await Promise.race([save, new Promise<never>((_resolve, reject) => {
      if (signal) {
        onAbort = () => reject(new Error("Response cancelled."))
        signal.addEventListener("abort", onAbort, { once: true })
        if (signal.aborted) onAbort()
      }
    })])
  } catch { throw new Error(signal?.aborted ? "Response cancelled." : SNAPSHOT_FAILURE) }
  finally { if (onAbort) signal?.removeEventListener("abort", onAbort) }
  if (signal?.aborted) throw new Error("Response cancelled.")
}

/**
 * Wraps the protocol-frame stream so each frame's usage + reported model are
 * captured into `SourceStreamState`. Throws are propagated AFTER flagging
 * the state as failed so respond-telemetry's `recordPerformance` writes
 * `failed=true`. Probes `event.model`, `event.response.model`, and
 * `event.message.model` for a single generator that works across protocols
 * even when an upstream emits an unexpected shape (defence in depth, same
 * as messages/respond.ts).
 */
async function* consumeWithState<T>(
  events: AsyncIterable<ProtocolFrame<T>>,
  state: SourceStreamState,
  dump?: DumpAccumulator | null,
): AsyncGenerator<ProtocolFrame<T>> {
  try {
    for await (const frame of events) {
      if (frame.type === 'event') {
        const evObj = frame.event as {
          model?: unknown
          modelVersion?: unknown
          response?: { model?: unknown }
          message?: { model?: unknown }
        }
        state.rememberModelKey(evObj.model ?? evObj.modelVersion ?? evObj.response?.model ?? evObj.message?.model)
        state.rememberFailure(frame.event, 'responses')
        const normalized = normalizeStreamEventModel(frame.event, state.publicModel)
        state.rememberUsage(normalized)
        const output = normalized === frame.event ? frame : { ...frame, event: normalized as T }
        dump?.frame(output as ProtocolFrame<unknown>)
        yield output
        continue
      }
      dump?.frame(frame as ProtocolFrame<unknown>)
      yield frame
    }
  } catch (err) {
    if (!state.cancelled) {
      state.failedAfter()
      dump?.failed(err)
    }
    throw err
  }
}

/** Observe bounded execution metadata before constructing optional sink input. */
async function prepareProjectionInput<T>(
  result: LlmEventResult<ProtocolFrame<T>>,
  state: SourceStreamState,
  telemetryCtx: TelemetryRequestContext | undefined,
): Promise<{ metadata: ResponsesMetadataObservation; identity: EventResultMetadata["modelIdentity"]; performance: EventResultMetadata["performance"]; settled: boolean }> {
  telemetryCtx?.metrics?.finish(state.cancelled ? "cancelled" : state.failed ? "error" : "success")
  const fallback = { modelIdentity: { ...result.modelIdentity, ...(telemetryCtx ? { incomingModel: telemetryCtx.incomingModel } : {}) }, performance: result.performance }
  const observation = state.cancelled ? { settled: true as const, value: { status: "skipped" as const, value: fallback } }
    : await settleStreamMetadata(eventResultMetadata(result, telemetryCtx).then(
      value => ({ status: "observed" as const, value }),
      () => ({ status: "rejected" as const, value: fallback }),
    ))
  const status = observation.settled ? observation.value.status : "timed-out"
  const md = observation.settled ? observation.value.value : fallback
  const identity = result.finalMetadata && !state.cancelled && status === "observed"
    ? md.modelIdentity
    : finalModelIdentity(md.modelIdentity, state.modelKey, result.resolveModelIdentity)
  return {
    metadata: { status, source: status === "observed" && result.finalMetadata ? "final" : "attempt", modelIdentity: identity, performance: md.performance },
    identity, performance: md.performance, settled: status === "observed" || status === "skipped",
  }
}

async function readLegacyJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) return null
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ""
  const onAbort = (): void => { void reader.cancel().catch(() => {}) }
  signal.addEventListener("abort", onAbort, { once: true })
  if (signal.aborted) onAbort()
  try {
    while (!signal.aborted) {
      const next = await reader.read()
      if (next.done) break
      text += decoder.decode(next.value, { stream: true })
    }
    if (signal.aborted) throw new Error("Response cancelled.")
    return JSON.parse(text + decoder.decode()) as unknown
  } finally {
    signal.removeEventListener("abort", onAbort)
    reader.releaseLock()
  }
}

export const isResponsesTurnTerminal = (event: ResponsesStreamEvent): boolean =>
  ["response.completed", "response.incomplete", "response.failed", "error"].includes(event.type)

export function responsesTerminalBody(event: ResponsesStreamEvent): unknown {
  if (event.type !== "error") return (event as { response?: unknown }).response
  const error = event as { error?: unknown; message?: string }
  return error.error ? { error: error.error } : { error: { type: "api_error", message: error.message ?? "Response stream failed." } }
}

export interface ResponsesTurnCompletion {
  readonly outcome: "completed" | "incomplete" | "failed" | "cancelled"
  readonly response?: CompletedResponsesSnapshot
  readonly cleanupComplete: boolean
}

export interface ResponsesMetadataObservation {
  readonly status: "observed" | "skipped" | "rejected" | "timed-out"
  readonly source?: "attempt" | "final"
  readonly modelIdentity?: EventResultMetadata["modelIdentity"]
  readonly performance?: EventResultMetadata["performance"]
}

/** Execution facts are settled before optional projections. They do not certify storage. */
export interface ResponsesExecutionFacts {
  readonly outcome: ResponsesTurnCompletion["outcome"]
  readonly response?: CompletedResponsesSnapshot
  readonly rawCleanupComplete: boolean
  readonly continuation: "skipped" | "fulfilled" | "rejected"
  readonly metadata: ResponsesMetadataObservation
}

/** Fulfilled means the invoked operation returned; helpers can internally catch storage errors. */
export interface ResponsesProjectionReceipts {
  readonly usage: "fulfilled" | "rejected" | "skipped"
  readonly performance: "fulfilled" | "rejected" | "skipped"
  readonly dumpMetadata: "fulfilled" | "rejected" | "skipped"
  readonly dumpFinalization: "fulfilled" | "rejected" | "skipped"
}

export interface ResponsesTurnMetadata {
  readonly status: number
  readonly headers?: Headers
  readonly body?: unknown
}

export interface ResponsesTurn {
  readonly events: AsyncGenerator<ResponsesStreamEvent>
  readonly abortController: AbortController
  readonly completion: Promise<ResponsesTurnCompletion>
  readonly facts: Promise<ResponsesExecutionFacts>
  readonly receipts: Promise<ResponsesProjectionReceipts>
  readonly ready: Promise<ResponsesTurnMetadata>
  readonly wantsStream: boolean
  readonly mergedInputItems: readonly unknown[]
  recordSentPayloadBytes(byteLength: number): void
}

export interface PreparedResponsesTurn {
  readonly result: RespondResponsesInput
  readonly options: ResponsesTurnOptions
}

type ResponsesTurnInput = RespondResponsesInput | (() => Promise<PreparedResponsesTurn>)

/** Created before preparation starts, so a platform can own completion from
 * turn start. The iterator has one consumer and no producer-side event queue. */
export function createResponsesTurn(
  input: ResponsesTurnInput,
  initialOptions: ResponsesTurnOptions,
): ResponsesTurn {
  let pendingInput: ResponsesTurnInput | undefined = input
  const abortController = initialOptions.downstreamAbortController ?? new AbortController()
  const upstreamAbortController = initialOptions.upstreamAbortController ?? new AbortController()
  let options = { ...initialOptions, downstreamAbortController: abortController, upstreamAbortController }
  const completed = Promise.withResolvers<ResponsesTurnCompletion>()
  const ready = Promise.withResolvers<ResponsesTurnMetadata>()
  const facts = Promise.withResolvers<ResponsesExecutionFacts>()
  const receipts = Promise.withResolvers<ResponsesProjectionReceipts>()
  const sinkReceipts: { -readonly [K in keyof ResponsesProjectionReceipts]: ResponsesProjectionReceipts[K] } = {
    usage: "skipped", performance: "skipped", dumpMetadata: "skipped", dumpFinalization: "skipped",
  }
  let rawCleanupComplete = false
  let continuation: ResponsesExecutionFacts["continuation"] = "skipped"
  let metadataObservation: ResponsesMetadataObservation = { status: "skipped" }
  let factsResolved = false
  let result: RespondResponsesInput | undefined
  let state: SourceStreamState | undefined
  let source: AsyncIterator<ProtocolFrame<ResponsesStreamEvent>> | undefined
  let rawIterator: AsyncIterator<ProtocolFrame<unknown>> | undefined
  let running = false
  let settled = false
  let cleanupComplete = true
  let outcome: ResponsesTurnCompletion["outcome"] = "failed"
  let reusable: CompletedResponsesSnapshot | undefined
  let pendingSave: Promise<void> | undefined
  let canonicalBody: unknown
  let terminalDelivered = false
  let finalizing: Promise<void> | undefined
  let metadata: ResponsesTurnMetadata = { status: 200 }
  const onAbort = (): void => {
    upstreamAbortController.abort(abortController.signal.reason)
    if (state) state.cancelled = true
    options.dump?.cancelled()
    options.telemetryCtx?.metrics?.finish("cancelled")
    void preparation.then(async () => {
      if (running) await stopEvents()
      else await finalize()
    }).catch(() => {})
  }
  abortController.signal.addEventListener("abort", onAbort, { once: true })
  const preparation = Promise.resolve().then(async () => {
    // Turn callbacks outlive preparation; release the factory's captured request state once this callback owns it.
    const ownedInput = pendingInput
    pendingInput = undefined
    if (ownedInput === undefined) throw new Error("Responses preparation input is unavailable.")
    if (typeof ownedInput === "function" && abortController.signal.aborted) {
      ready.resolve({ status: 499, body: { error: { type: "api_error", message: "Response cancelled." } } })
      return
    }
    const prepared = typeof ownedInput === "function" ? await ownedInput() : { result: ownedInput, options }
    result = prepared.result
    options = { ...prepared.options, downstreamAbortController: abortController, upstreamAbortController }
    if (!("kind" in result) && result.type === "events") {
      state = new SourceStreamState(result.modelIdentity.modelKey, result.modelIdentity.model, result.modelIdentity.executedModelKey)
      state.cancelled = abortController.signal.aborted
      const iterator = result.events[Symbol.asyncIterator]()
      let returned: Promise<IteratorResult<ProtocolFrame<unknown>>> | undefined
      rawIterator = {
        next: () => iterator.next(),
        return: () => returned ??= Promise.resolve().then(() => iterator.return?.() ?? { done: true as const, value: undefined }),
      }
    }
    if ("kind" in result) {
      metadata = { status: result.response.status, headers: new Headers(result.response.headers) }
      if (!result.response.headers.get("content-type")?.includes("text/event-stream")) metadata = { ...metadata, body: await readLegacyJson(result.response, upstreamAbortController.signal) }
    } else if (result.type === "upstream-error") {
      const response = await forwardUpstreamError(upstreamErrorToResponse(result), "responses")
      metadata = { status: response.status, headers: new Headers(response.headers), body: await response.json() }
      options.dump?.error("upstream", result.performance?.upstream ?? undefined)
    } else if (result.type === "internal-error") {
      metadata = { status: result.status, body: { error: { type: "api_error", message: result.error.message } } }
      options.dump?.failed(result.error.message)
    }
    const headers = new Headers(metadata.headers)
    if (options.telemetryCtx?.metrics?.synthetic) headers.set("x-gateway-stream-timing", "unavailable")
    if (options.finalizeDump && options.dump?.recordId) {
      headers.set("x-dump-record-id", options.dump.recordId)
      headers.set("x-dump-key-id", options.dump.keyId)
    }
    metadata = { ...metadata, headers }
    ready.resolve(metadata)
  }).catch(error => {
    metadata = { status: 502, headers: new Headers(), body: { error: { type: "api_error", message: error instanceof Error ? error.message : "Response preparation failed." } } }
    ready.resolve(metadata)
  })

  function resolveFacts(): void {
    if (factsResolved) return
    factsResolved = true
    facts.resolve(Object.freeze({
      outcome: abortController.signal.aborted ? "cancelled" : outcome,
      ...(reusable && !abortController.signal.aborted && outcome === "completed" ? { response: reusable } : {}),
      rawCleanupComplete, continuation, metadata: Object.freeze(metadataObservation),
    }))
  }

  async function invokeSink(name: keyof ResponsesProjectionReceipts, operation: () => void | Promise<void>): Promise<void> {
    try { await operation(); sinkReceipts[name] = "fulfilled" }
    catch (error) { sinkReceipts[name] = "rejected"; throw error }
  }

  function finalize(): Promise<void> {
    finalizing ??= (async () => {
      if (settled) return
      const closed = await Promise.all([...(source ? [closeStream(source)] : []), ...(rawIterator ? [closeStream(rawIterator)] : [])])
      rawCleanupComplete = closed.every(Boolean)
      if (result && !("kind" in result) && result.type === "events" && upstreamAbortController.signal.aborted) {
        rawCleanupComplete = await disposeEventProducerBody(result.discardProducer) && rawCleanupComplete
      }
      if (result && "kind" in result && result.response.body && !result.response.body.locked && upstreamAbortController.signal.aborted) {
        rawCleanupComplete = (await settleStreamMetadata(result.response.body.cancel())).settled && rawCleanupComplete
      }
      cleanupComplete = rawCleanupComplete
      if (pendingSave) await pendingSave.catch(() => {})
      try {
        let projection: Awaited<ReturnType<typeof prepareProjectionInput>> | undefined
        try {
          // Preserve the original no-sink path: it never observes finalMetadata.
          if (result && !("kind" in result) && result.type === "events" && state && (options.telemetryCtx || options.dump)) {
            projection = await prepareProjectionInput(result, state, options.telemetryCtx)
            metadataObservation = projection.metadata
            cleanupComplete = projection.settled && cleanupComplete
          }
        } finally { resolveFacts() }
        if (result && !("kind" in result)) {
          if (result.type === "events" && state && projection && !state.persisted) {
            state.persisted = true
            const { identity, performance } = projection
            const sourceState = state
            const dump = options.dump
            if (dump) await invokeSink("dumpMetadata", () => {
              dump.success(identity, sourceState.usage.tokens)
              if (sourceState.cancelled) dump.cancelled()
              else if (sourceState.failed) dump.failed("responses stream failed")
            })
            const telemetryCtx = options.telemetryCtx
            if (telemetryCtx) {
              await invokeSink("usage", () => recordUsage(telemetryCtx, identity, sourceState.usage.tokens))
              await invokeSink("performance", () => recordPerformance(telemetryCtx, performance, sourceState.failed && !sourceState.cancelled, undefined, performanceTargetFromTranslatorPair(identity), identity))
            }
          } else if (result.type !== "events" && options.telemetryCtx) {
            const errorResult = result
            const telemetryCtx = options.telemetryCtx
            await invokeSink("performance", () => recordPerformance(telemetryCtx, errorResult.performance, true, undefined, errorResult.type === "upstream-error" ? errorResult.targetApi : undefined))
          }
        }
      } finally {
        const dump = options.dump
        if (options.finalizeDump && dump?.finalizeTurn) {
          const status = metadata.status >= 400 ? metadata.status : outcome === "failed" && !options.wantsStream ? 502 : metadata.status
          await invokeSink("dumpFinalization", () => dump.finalizeTurn(status, [...(metadata.headers ?? new Headers()).entries()], canonicalBody))
        }
      }
    })().catch(() => { cleanupComplete = false }).finally(() => {
      resolveFacts()
      settled = true
      abortController.signal.removeEventListener("abort", onAbort)
      receipts.resolve(Object.freeze({ ...sinkReceipts }))
      completed.resolve({ outcome: abortController.signal.aborted ? "cancelled" : outcome, ...(reusable && !abortController.signal.aborted && outcome === "completed" ? { response: reusable } : {}), cleanupComplete })
    })
    return finalizing
  }

  async function* normalized(): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {
    if (!result || metadata.status >= 400) {
      yield eventFrame({ type: "error", ...(metadata.body as object) } as ResponsesStreamEvent)
      return
    }
    if ("kind" in result) {
      if (metadata.body !== undefined) {
        const body = metadata.body as { status?: string }
        const type = body.status === "failed" ? "response.failed" : body.status === "incomplete" ? "response.incomplete" : "response.completed"
        yield eventFrame({ type, response: metadata.body } as ResponsesStreamEvent)
      } else if (result.response.body) {
        // Legacy dispatch input only. Normal execution and future WS never
        // construct or parse an HTTP response to obtain canonical events.
        for await (const frame of parseSSEStream(result.response.body, { signal: upstreamAbortController.signal })) {
          if (frame.data === "[DONE]") continue
          const event = JSON.parse(frame.data) as Record<string, unknown>
          yield eventFrame((frame.event && !event.type ? { ...event, type: frame.event } : event) as unknown as ResponsesStreamEvent)
        }
      }
      return
    }
    if (result.type !== "events" || !state) return
    const iterator = rawIterator
    const ownedFrames = iterator ? { [Symbol.asyncIterator]: () => iterator } : result.events
    const observedState = state
    const source = prepareResponsesSource({
      result,
      rawFrames: guardAffinityFrames(ownedFrames, options.affinity),
      wantsStream: options.wantsStream,
      upstreamAbortController,
      observe: frames => consumeWithState(frames, observedState, options.dump),
    })
    yield* source.frames
  }

  async function* run(): AsyncGenerator<ResponsesStreamEvent> {
    running = true
    let terminal: ResponsesStreamEvent | undefined
    const output = new ResponsesFinalOutput()
    const tail = new StreamTail()
    try {
      await preparation
      if (abortController.signal.aborted) return
      source = normalized()[Symbol.asyncIterator]()
      const egress = new AffinityEgress(options.affinity)
      while (!abortController.signal.aborted) {
        const next = await tail.next(source, abortController.signal)
        if (next.done) break
        tail.observe(next.value)
        if (next.value.type !== "event") continue
        const event = next.value.event
        if (terminal) {
          if (event.type === "error" || event.type === "response.failed") { terminal = event; break }
          continue
        }
        if (isResponsesTurnTerminal(event)) {
          terminal = output.observe(event)
          if (event.type === "error" || event.type === "response.failed") break
          tail.start()
          continue
        }
        const observed = output.observe(event)
        if (!options.wantsStream) continue
        const canonical = await egress.responseEvent(observed)
        if (!abortController.signal.aborted) { options.telemetryCtx?.metrics?.observeOutput("responses", canonical); yield canonical }
      }
      if (abortController.signal.aborted) return
      if (!terminal) throw new Error("responses stream ended without terminal lifecycle frame")
      terminal = await egress.responseEvent(terminal)
      if (terminal.type === "response.completed") {
        await persistCompleted(terminal.response, options, save => {
          pendingSave = save
          void save.then(() => { continuation = "fulfilled" }, () => { continuation = "rejected" })
        })
        outcome = reusableResponse(terminal.response) ? "completed" : "incomplete"
        if (outcome === "completed") reusable = terminal.response as CompletedResponsesSnapshot
      } else outcome = terminal.type === "response.incomplete" ? "incomplete" : "failed"
      if (outcome === "failed") { state?.failedAfter(); upstreamAbortController.abort() }
      if (!abortController.signal.aborted) {
        canonicalBody = responsesTerminalBody(terminal)
        options.telemetryCtx?.metrics?.observeOutput("responses", terminal)
        terminalDelivered = true
        yield terminal
      }
    } catch (error) {
      upstreamAbortController.abort(error)
      if (!abortController.signal.aborted) {
        outcome = "failed"
        state?.failedAfter()
        const message = error instanceof Error ? error.message : "Response stream failed."
        options.dump?.failed(message)
        const failure = { type: "error", message } as ResponsesStreamEvent
        canonicalBody = responsesTerminalBody(failure)
        yield failure
      }
    } finally {
      tail.dispose()
      if (!terminal && !upstreamAbortController.signal.aborted) upstreamAbortController.abort()
      await finalize()
    }
  }
  const events = run()
  const returnEvents = events.return.bind(events)
  const throwEvents = events.throw.bind(events)
  const stopEvents = () => returnEvents(undefined)
  events.return = async value => {
    if (!settled && !terminalDelivered) abortController.abort()
    if (!running) { await preparation; await finalize() }
    return returnEvents(value)
  }
  events.throw = async error => {
    abortController.abort()
    if (!running) { await preparation; await finalize() }
    return throwEvents(error)
  }
  // Register the complete ownership promise now, including pre-consumption abort.
  waitUntil(completed.promise.then(() => {}))
  if (abortController.signal.aborted) onAbort()
  return { events, abortController, completion: completed.promise, facts: facts.promise, receipts: receipts.promise, ready: ready.promise, wantsStream: initialOptions.wantsStream, get mergedInputItems() { return options.mergedInputItems ?? [] }, recordSentPayloadBytes: size => options.dump?.recordSentPayloadBytes?.(size) }
}
