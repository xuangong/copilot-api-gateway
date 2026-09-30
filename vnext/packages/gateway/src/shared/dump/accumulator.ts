// Per-request dump pipeline. Opens the dump session (request snapshot +
// opt-in decision) and exposes the mid-flight hooks the respond layer
// calls to record outcomes and frames. When the api key has no retention
// configured, opening returns null and the data plane pays no per-request
// cost.
//
// vNext adaptations vs reference (copilot-gateway/src/dump/accumulator.ts):
//   - The request's background executor is captured when the dump opens.
//   - `DumpUpstreamRef` has no `color` — vNext upstreams row has no color.
//   - `UpstreamRecord.provider` in vNext (not `.kind`) supplies the
//     upstream's `UpstreamKind`.
//   - `TelemetryModelIdentity` imported from `@vibe-llm/protocols/common`.

import type { Context } from "hono"
import type { KitCanonicalCompletion } from "@vibe-core/chat-flow-kit"
import { getBackgroundExecutor, type BackgroundExecutor } from "@vibe-core/platform"
import type { ProtocolFrame } from "@vibe-core/result"
import type { TelemetryModelIdentity } from "@vibe-llm/protocols/common"

import { getDumpBroker, getDumpCaptureBudget, getDumpStore } from "./registry.ts"
import { retireDumpCapture, type DumpCaptureBudget, type DumpCaptureReservation } from "./capture-budget.ts"
import { UpstreamExchangeCollector } from "./upstream-attempts.ts"
import { createUpstreamDialObservationContext } from "./upstream-dial-adapter.ts"
import type { UpstreamExchanges } from "./upstream-attempts.ts"
import type { RequestBody } from "./request-body.ts"
import type {
  DumpErrorMeta,
  DumpMetadata,
  DumpStreamEvent,
  DumpUpstreamRef,
  DumpWriteRecord,
  PreparedDumpRequestBody,
  DumpWriteResponseBody,
} from "./types.ts"
import { getRepo } from "../../repo/index.ts"
import type { ApiKey, TokenUsage } from "../../repo/types.ts"
import type { ApiKeyId, DumpRecordId, UpstreamId } from "../../repo/branded-ids.ts"
import { ulid } from "../ulid.ts"

// Frozen at ctx construction so `finalize` never has to re-read a stream
// the handler already consumed.
interface RequestSnapshot {
  readonly method: string
  readonly path: string
  readonly headers: ReadonlyArray<readonly [string, string]>
  readonly bodyByteLength: number
  readonly streamError: string | null
}

interface ResponseSnapshot {
  readonly status: number
  readonly headers: ReadonlyArray<readonly [string, string]>
  readonly isStream: boolean
  bytes: Uint8Array
  readonly payloadBytes: number
  readonly streamError: string | null
}

// Anthropic-style disjoint per-dimension counts: input excludes cache reads
// and cache writes; sum the present ones onto the dump's single inputTokens
// column. Missing dimensions stay null (not measured) instead of zero so a
// recorded zero genuinely means "upstream said zero".
const tokenUsageInput = (usage: TokenUsage | null): number | null => {
  if (!usage) return null
  const { input, input_cache_read, input_cache_write } = usage
  if (input === undefined && input_cache_read === undefined && input_cache_write === undefined) return null
  return (input ?? 0) + (input_cache_read ?? 0) + (input_cache_write ?? 0)
}

const oneLineError = (err: unknown): string => {
  const msg = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").trim()
  return msg.length > 500 ? `${msg.slice(0, 497)}…` : msg
}

const ownHeaderPairs = (pairs: ReadonlyArray<readonly [string, string]>): ReadonlyArray<readonly [string, string]> =>
  Object.freeze(pairs.map(([name, value]) => Object.freeze([name, value] as const)))

const headerPairs = (headers: Headers): ReadonlyArray<readonly [string, string]> => {
  const pairs: Array<readonly [string, string]> = []
  headers.forEach((value, name) => { pairs.push(Object.freeze([name, value] as const)) })
  return Object.freeze(pairs)
}

const resolveUpstreamRef = async (id: string | null): Promise<DumpUpstreamRef | null> => {
  if (!id) return null
  const upstream = await getRepo().upstreams.getById(id as UpstreamId)
  if (!upstream) return null
  return { id: upstream.id as UpstreamId, name: upstream.name, kind: upstream.provider }
}

const inactiveCall = { beginAttempt: () => undefined }
const inactiveObserver = { beginCall: () => inactiveCall }
const inactiveObservation: ReturnType<typeof createUpstreamDialObservationContext> = {
  forOperation: () => inactiveObserver,
}

interface TerminalRecord {
  keyId: ApiKeyId
  record: DumpWriteRecord
}

const emptyRequestBody = (): PreparedDumpRequestBody => ({ encoding: "identity", bytes: new Uint8Array(), decodedByteLength: 0 })

const writeFailureFor = (keyId: ApiKeyId, recordId: DumpRecordId) => (error: unknown): void => {
  console.error(`[dump] write failed for key=${keyId} record=${recordId}`, oneLineError(error))
}

const publicationFor = (keyId: ApiKeyId, meta: DumpMetadata) => (): Promise<void> =>
  getDumpBroker().publish(keyId, meta)

// These reactions own only metadata. Their lexical scopes must not keep the
// raw record or the record-building frame alive through storage/publication.
function persistTerminalRecord(input: TerminalRecord | null): Promise<void> {
  if (input === null) return Promise.resolve()
  const failed = writeFailureFor(input.keyId, input.record.meta.id)
  try {
    return getDumpStore().put(input.keyId, input.record)
      .then(publicationFor(input.keyId, input.record.meta))
      .catch(failed)
  } catch (error) {
    failed(error)
    return Promise.resolve()
  }
}

async function drainResponse(
  body: ReadableStream<Uint8Array>, status: number,
  headers: ReadonlyArray<readonly [string, string]>, isStream: boolean,
  admit: (bytes: number) => boolean,
): Promise<ResponseSnapshot> {
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let streamError: string | null = null
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      total += value.byteLength
      if (admit(value.byteLength * 3 + 64)) chunks.push(new Uint8Array(value))
      else chunks.length = 0
    }
  } catch (error) {
    streamError = oneLineError(error)
  } finally { reader.releaseLock() }
  const bytes = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.byteLength, 0))
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return { status, headers, isStream, bytes, payloadBytes: total, streamError }
}

export class DumpAccumulator {
  private events: DumpStreamEvent[] | null = []
  private sentPayloadBytes = 0
  private model: string | null = null
  private upstreamId: string | null = null
  private inputTokens: number | null = null
  private outputTokens: number | null = null
  private errorMeta: DumpErrorMeta | null = null
  private preparedRequestBody: Promise<PreparedDumpRequestBody> | null
  private readonly preparationSettled: Promise<void>
  private readonly capture: DumpCaptureReservation
  private captureOmitted = false
  private upstreamExchangeCollector: UpstreamExchangeCollector | null = null
  private ownsUpstreamCollector = false
  private upstreamObservation: ReturnType<typeof createUpstreamDialObservationContext> | null = null
  private terminalWrite: Promise<void> | null = null
  // Pre-allocated at construction so `finalize(Response)` can echo it as an
  // `X-Dump-Record-Id` header before the write completes. The write path
  // uses this same id to persist the dump row.
  readonly recordId: DumpRecordId

  constructor(
    private readonly apiKey: ApiKey,
    private readonly requestSnapshot: RequestSnapshot,
    requestBody: Uint8Array,
    private readonly startedAt: number,
    private readonly background: BackgroundExecutor = getBackgroundExecutor(),
    budget: DumpCaptureBudget = getDumpCaptureBudget(),
  ) {
    this.recordId = ulid(startedAt) as DumpRecordId
    this.capture = budget.open()
    try {
      this.preparedRequestBody = this.capture.bytes(requestBody.buffer.byteLength * 3 + 256)
        ? getDumpStore().prepareRequestBody(requestBody) : Promise.resolve(emptyRequestBody())
    } catch (error) { this.preparedRequestBody = Promise.reject(error) }
    // Preparation starts eagerly and is awaited at terminal persistence. Mark
    // a rejection handled immediately so a long upstream wait cannot surface
    // it as an unhandled promise before `write()` records the dump failure.
    this.preparationSettled = this.preparedRequestBody.then(() => {}, () => {})
    if (this.capture.reason) this.omitCapture()
  }

  private omitCapture(): void {
    if (this.captureOmitted) return
    this.captureOmitted = true
    if (this.events !== null) this.events = []
    this.preparedRequestBody = this.preparedRequestBody?.then(emptyRequestBody) ?? null
    // Keep failures handled immediately even while the upstream is pending.
    void this.preparedRequestBody?.catch(() => {})
    if (this.ownsUpstreamCollector) this.upstreamExchangeCollector?.abandon()
    this.upstreamExchangeCollector = null
    this.upstreamObservation = null
    this.ownsUpstreamCollector = false
  }

  private admitBytes(bytes: number): boolean {
    if (this.capture.bytes(bytes)) return true
    this.omitCapture()
    return false
  }

  private retire(work: Promise<void>): Promise<void> {
    return retireDumpCapture(work, this.preparationSettled, this.capture)
  }

  // --- mid-flight hooks (called from per-protocol respond layer) ---

  requestedModel(model: string): void {
    this.model = model
  }

  // Exposed so http-layer wrappers can look up the api key id (typed as
  // string here since ApiKey.id is not branded yet) without piercing
  // encapsulation.
  get keyId(): string {
    return this.apiKey.id
  }

  attachUpstreamExchangeCollector(collector: UpstreamExchangeCollector): void {
    if (this.events === null || this.captureOmitted) return
    this.upstreamExchangeCollector ??= collector
  }

  upstreamDialObservation(): ReturnType<typeof createUpstreamDialObservationContext> {
    if (this.events === null || this.captureOmitted) return inactiveObservation
    if (this.upstreamExchangeCollector === null) {
      this.upstreamExchangeCollector = new UpstreamExchangeCollector(this.startedAt)
      this.ownsUpstreamCollector = true
    }
    this.upstreamObservation ??= createUpstreamDialObservationContext(this.upstreamExchangeCollector)
    return this.upstreamObservation
  }

  error(kind: "upstream" | "gateway", upstream?: string): void {
    if (this.canonicalCancelled) return
    this.errorMeta = { kind }
    if (upstream !== undefined) this.upstreamId = upstream
  }

  cancelled(identity?: TelemetryModelIdentity, usage: TokenUsage | null = null): void {
    if (this.canonicalCancelled) return
    this.errorMeta = { kind: "cancelled", reason: "client_cancelled" }
    // Synchronous producer fallback must reach the transport handoff without
    // replacing authoritative scalars that semantic completion already supplied.
    if (identity) {
      this.model ??= identity.model
      this.upstreamId ??= identity.upstream
      this.inputTokens ??= tokenUsageInput(usage)
      this.outputTokens ??= usage?.output ?? null
    }
  }

  failed(reason: unknown): void {
    if (this.canonicalCancelled) return
    if (this.errorMeta?.kind === "cancelled") return
    this.errorMeta = { kind: "failed", reason: typeof reason === "string" ? reason : oneLineError(reason) }
  }

  // Retain a budget-owned JSON projection of each canonical frame. Strings are
  // shared, objects are copied; neither serialization nor parsing runs here.
  frame(frame: ProtocolFrame<unknown>): void {
    if (this.events === null || this.captureOmitted) return
    const captured = this.capture.frame({ frame, ts: Date.now() - this.startedAt })
    if (captured) this.events.push(captured.value)
    else this.omitCapture()
  }

  recordSentPayloadBytes(byteLength: number): void {
    this.sentPayloadBytes += byteLength
  }

  success(identity: TelemetryModelIdentity, usage: TokenUsage | null): void {
    if (this.canonicalCancelled) return
    // `requestedModel` is the client-facing identity and must survive key
    // routing. Successful handlers still supply the resolved identity below
    // for upstream/cost metadata, but only use its model when no request
    // model was available (for example, a protocol stream opened before its
    // model-bearing frame arrived).
    this.model ??= identity.model
    this.upstreamId = identity.upstream
    this.inputTokens = tokenUsageInput(usage)
    this.outputTokens = usage?.output ?? null
  }

  // --- response-side: handler exit ---

  // No response was handed off, so there is no status or terminal record to
  // invent. Seal this owner while its already-started preparation settles.
  // A previously selected write remains the sole terminal owner.
  abandon(): Promise<void> {
    if (this.terminalWrite !== null) return this.terminalWrite
    const collector = this.ownsUpstreamCollector ? this.upstreamExchangeCollector : null
    this.events = null
    this.preparedRequestBody = null
    this.upstreamExchangeCollector = null
    this.upstreamObservation = null
    this.ownsUpstreamCollector = false
    const retired = this.retire(Promise.resolve().then(() => { collector?.abandon() }))
    this.terminalWrite = retired
    // Both cleanup and scheduler failures are diagnostic-only. Retirement
    // still runs and waits preparation even if background registration fails.
    void retired.catch(() => {})
    try { this.background.waitUntil(retired) } catch { /* Retirement already owns cleanup. */ }
    return retired
  }

  // Schedules the dump-record write at the turn's terminal point. Two input
  // shapes:
  //
  //   • `(status, headers)` — no HTTP Response object to tee. The WebSocket
  //     Responses path uses this: its "response" is the stream of frames
  //     already captured via `frame()`.
  //   • `(response)` — tees the response body so the client gets bytes
  //     flowing while a background reader accumulates the other half.
  //
  // The background drain → record assembly → store put → broker publish is
  // scheduled through `waitUntil` so dump write failures cannot turn a
  // successful upstream call into a 502.
  // The turn supplies its canonical body when no provider frame log exists.
  // This fallback never reads or tees a transport response.
  finalizeTurn(status: number, headers: ReadonlyArray<readonly [string, string]>, canonicalBody?: unknown): Promise<void> {
    if (this.terminalWrite !== null) return this.terminalWrite
    try {
      const hasFrames = (this.events?.length ?? 0) > 0
      let bytes = new Uint8Array()
      if (!hasFrames && canonicalBody !== undefined && !this.captureOmitted) {
        const projected = this.capture.project(canonicalBody)
        if (!projected && this.capture.invalidJson) throw new TypeError("Dump fallback is not JSON serializable")
        if (projected) {
          const serialized = JSON.stringify(projected.value)
          // UTF-8 needs at most three bytes per UTF-16 code unit. Reserve the
          // owned output before encoding; JSON/codec scratch is a separate domain.
          if (this.admitBytes((serialized?.length ?? 0) * 3 + 64)) bytes = new TextEncoder().encode(serialized)
        }
        else this.omitCapture()
      }
      return this.write({ status, headers: ownHeaderPairs(headers), isStream: hasFrames,
        bytes, payloadBytes: this.sentPayloadBytes, streamError: null })
    } catch (error) {
      // This API formerly used an async frame: stringify failures must still
      // reject its completion instead of escaping synchronously to the caller.
      this.terminalWrite = this.retire(Promise.reject(error))
      this.events = null
      this.preparedRequestBody = null
      if (this.ownsUpstreamCollector) this.upstreamExchangeCollector?.abandon()
      this.upstreamExchangeCollector = null
      this.upstreamObservation = null
      this.ownsUpstreamCollector = false
      return this.terminalWrite
    }
  }

  finalize(status: number, headers: ReadonlyArray<readonly [string, string]>): void
  finalize(response: Response, completion?: KitCanonicalCompletion): Response
  finalize(...args: [number, ReadonlyArray<readonly [string, string]>] | [Response, KitCanonicalCompletion?]): void | Response {
    if (typeof args[0] === "number") {
      if (this.terminalWrite !== null) return
      const [status, headers] = args as [number, ReadonlyArray<readonly [string, string]>]
      this.background.waitUntil(this.write({
        status,
        headers: ownHeaderPairs(headers),
        isStream: (this.events?.length ?? 0) > 0,
        bytes: new Uint8Array(),
        payloadBytes: this.sentPayloadBytes,
        streamError: null,
      }))
      return
    }

    const [response, completion] = args as [Response, KitCanonicalCompletion?]
    if (this.terminalWrite !== null) {
      return new Response(response.body, {
        status: response.status, statusText: response.statusText, headers: this.withDumpHeaders(response.headers),
      })
    }
    if (completion) return this.finalizeCanonical(response, completion)
    const responseStatus = response.status
    const responseHeaders = headerPairs(response.headers)

    if (response.body === null) {
      this.finalize(responseStatus, responseHeaders)
      return new Response(null, {
        status: response.status,
        statusText: response.statusText,
        headers: this.withDumpHeaders(response.headers),
      })
    }

    const isStream = (response.headers.get("content-type") ?? "").startsWith("text/event-stream")
    const [forClient, forCapture] = response.body.tee()
    // Register the first finalization immediately, while frames may still
    // arrive during the drain. Body ownership seals only in the builder.
    this.terminalWrite = this.retire(drainResponse(forCapture, responseStatus, responseHeaders, isStream, bytes => this.admitBytes(bytes))
      .then(this.buildTerminalRecord.bind(this))
      .then(persistTerminalRecord))
    this.background.waitUntil(this.terminalWrite)

    return new Response(forClient, {
      status: response.status,
      statusText: response.statusText,
      headers: this.withDumpHeaders(response.headers),
    })
  }

  // Cancellation seals scalar metadata at the transport boundary. Ordinary
  // terminal assembly retains its existing late-scalar observation contract.
  private canonicalCancelled = false

  private finalizeCanonical(response: Response, completion: KitCanonicalCompletion): Response {
    const status = response.status
    const headers = headerPairs(response.headers)
    const isStream = (response.headers.get("content-type") ?? "").startsWith("text/event-stream")
    const transport = Promise.withResolvers<{ payloadBytes: number; streamError: string | null; cancelled: boolean }>()
    const semantic = completion.settled.then(() => null, oneLineError)
    const cancelCompletion = completion.cancel
    let fallbackBody = (this.events?.length ?? 0) === 0 ? completion.fallbackBody : undefined
    if (fallbackBody !== undefined && !this.admitBytes(fallbackBody.length * 5 + 32)) fallbackBody = undefined
    this.terminalWrite = this.retire(transport.promise.then(async snapshot => {
      const semanticError = snapshot.cancelled ? null : await semantic
      const bytes = !this.captureOmitted && (this.events?.length ?? 0) === 0 && fallbackBody !== undefined
        ? new TextEncoder().encode(fallbackBody) : new Uint8Array()
      fallbackBody = undefined
      return this.buildTerminalRecord({ status, headers, isStream, bytes, ...snapshot,
        streamError: snapshot.streamError ?? semanticError })
    }).then(persistTerminalRecord))
    this.background.waitUntil(this.terminalWrite)
    let payloadBytes = 0
    let finished = false
    const complete = (streamError: string | null, cancelled = false): void => {
      if (finished) return
      finished = true
      transport.resolve({ payloadBytes, streamError, cancelled })
    }
    const reader = response.body?.getReader()
    if (!reader) complete(null)
    const body = reader ? new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await reader.read()
          if (finished) return
          if (next.done) {
            reader.releaseLock()
            controller.close()
            complete(null)
          } else {
            controller.enqueue(next.value)
            payloadBytes += next.value.byteLength
          }
        } catch (error) {
          if (finished) return
          reader.releaseLock()
          controller.error(error)
          complete(oneLineError(error))
        }
      },
      cancel: reason => {
        this.cancelled()
        cancelCompletion?.()
        this.canonicalCancelled = true
        // Source cleanup and already-started writes retain background ownership;
        // an unresolved semantic observer cannot hold the cancelled dump open.
        const cleanup = reader.cancel(reason).catch(() => {}).finally(() => reader.releaseLock())
        this.background.waitUntil(cleanup)
        complete(null, true)
      },
    }, { highWaterMark: 0 }) : null
    return new Response(body, {
      status, statusText: response.statusText, headers: this.withDumpHeaders(response.headers),
    })
  }

  // Copy the response headers and stamp X-Dump-* so the client can look up
  // its own dump record via the control plane. Only emitted when a dump
  // will actually be written (i.e. the accumulator was opened, which only
  // happens for keys with retention configured).
  private withDumpHeaders(source: Headers): Headers {
    const out = new Headers(source)
    out.set('x-dump-record-id', this.recordId)
    out.set('x-dump-key-id', this.apiKey.id)
    return out
  }

  // --- private: persist ---

  private write(response: ResponseSnapshot): Promise<void> {
    this.terminalWrite ??= this.retire(this.buildTerminalRecord(response).then(persistTerminalRecord))
    return this.terminalWrite
  }

  private async buildTerminalRecord(response: ResponseSnapshot): Promise<TerminalRecord | null> {
    // Use the record id allocated at ctx construction so the
    // `X-Dump-Record-Id` header the client already received matches the row
    // this write persists.
    const completedAt = Date.now()
    const recordId = this.recordId
    const events = this.events
    const preparedRequestBody = this.preparedRequestBody
    const collector = this.upstreamExchangeCollector
    const ownsCollector = this.ownsUpstreamCollector
    // Transfer references without mutating arrays or byte views the next
    // stage still needs. Old observation handles may retain the collector.
    this.events = null
    this.preparedRequestBody = null
    this.upstreamExchangeCollector = null
    this.upstreamObservation = null
    this.ownsUpstreamCollector = false
    let upstreamExchanges: UpstreamExchanges | null = null
    if (collector !== null) {
      try { upstreamExchanges = ownsCollector ? collector.takeSnapshot(completedAt) : collector.finish(completedAt) }
      catch {
        // Only the internally created collector belongs to this terminal
        // writer. Borrowed collectors retain ordinary finish/retry ownership.
        if (ownsCollector) collector.abandon()
      }
    }

    // Prefer the accumulator's frame log so dumps reflect the gateway's
    // frame sequence regardless of negotiated wire shape; passthrough
    // endpoints with no frames fall back to captured bytes.
    const responseBody: DumpWriteResponseBody = this.captureOmitted ? { type: "none" } : events !== null && events.length > 0
      ? { type: "stream", events }
      : response.bytes.byteLength > 0 || response.streamError !== null || response.isStream && response.payloadBytes > 0
        ? response.isStream
          ? { type: "stream", events: [] }
          : { type: "bytes", body: response.bytes, ownership: "transferred" }
        : { type: "none" }
    response.bytes = new Uint8Array()

    const meta: DumpMetadata = {
      id: recordId as DumpRecordId,
      startedAt: this.startedAt,
      completedAt,
      method: this.requestSnapshot.method,
      path: this.requestSnapshot.path,
      status: response.status,
      upstream: await resolveUpstreamRef(this.upstreamId),
      model: this.model,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      requestBytes: this.requestSnapshot.bodyByteLength,
      responseBytes: response.payloadBytes,
      durationMs: completedAt - this.startedAt,
      // Precedence: an explicit error stamp from the respond path wins;
      // otherwise a request-body read failure (operator-side payload didn't
      // arrive intact) outranks a response-body read failure.
      error: this.errorMeta
        ?? (this.requestSnapshot.streamError !== null ? { kind: "failed", reason: this.requestSnapshot.streamError } : null)
        ?? (response.streamError !== null ? { kind: "failed", reason: response.streamError } : null),
      ...(this.capture.reason ? { capture: { state: "omitted" as const, reason: this.capture.reason } } : {}),
    }

    // Commit the row before publishing so subscribers fetching detail off the meta frame find it.
    try {
      if (preparedRequestBody === null) throw new Error("Dump request body already transferred")
      const record: DumpWriteRecord = {
        meta,
        upstreamExchanges,
        request: {
          method: this.requestSnapshot.method,
          path: this.requestSnapshot.path,
          headers: this.requestSnapshot.headers,
          body: await preparedRequestBody,
        },
        response: {
          status: response.status,
          headers: response.headers,
          body: responseBody,
        },
      }
      return { keyId: this.apiKey.id, record }
    } catch (err) {
      writeFailureFor(this.apiKey.id, recordId)(err)
      return null
    }
  }
}

// Returns null when the api key opts out of dumps; callers then skip all
// per-request dump work. `method` is passed explicitly rather than read
// off the request so the WebSocket Responses path can record each turn
// as `WS /v1/responses` rather than the upgrade's `GET`.
export const openDumpAccumulator = (
  c: Context,
  method: string,
  apiKey: ApiKey,
  requestBody: RequestBody,
  background?: BackgroundExecutor,
): DumpAccumulator | null => {
  return openTransportDump({ method, path: c.req.path, headers: c.req.raw.headers }, apiKey, requestBody, background)
}

/** Plain metadata boundary shared by HTTP and per-message transports. */
export function openTransportDump(
  request: { method: string; path: string; headers: Headers }, apiKey: ApiKey, requestBody: RequestBody,
  background?: BackgroundExecutor,
): DumpAccumulator | null {
  if (apiKey.dumpRetentionSeconds === null) return null
  const executor = background ?? getBackgroundExecutor()
  const requestSnapshot: RequestSnapshot = {
    method: request.method,
    path: request.path,
    headers: headerPairs(request.headers),
    bodyByteLength: requestBody.bytes.byteLength,
    streamError: requestBody.streamError,
  }
  return new DumpAccumulator(apiKey, requestSnapshot, requestBody.bytes, Date.now(), executor)
}
