// Per-request dump pipeline. Opens the dump session (request snapshot +
// opt-in decision) and exposes the mid-flight hooks the respond layer
// calls to record outcomes and frames. When the api key has no retention
// configured, opening returns null and the data plane pays no per-request
// cost.
//
// vNext adaptations vs reference (copilot-gateway/src/dump/accumulator.ts):
//   - `BackgroundScheduler` parameter dropped; uses `waitUntil` from
//     `@vibe-core/platform` directly (see spec14 §BackgroundScheduler).
//   - `DumpUpstreamRef` has no `color` — vNext upstreams row has no color.
//   - `UpstreamRecord.provider` in vNext (not `.kind`) supplies the
//     upstream's `UpstreamKind`.
//   - `TelemetryModelIdentity` imported from `@vibe-llm/protocols/common`.

import type { Context } from "hono"
import { waitUntil } from "@vibe-core/platform"
import type { ProtocolFrame } from "@vibe-core/result"
import type { TelemetryModelIdentity } from "@vibe-llm/protocols/common"

import { getDumpBroker, getDumpStore } from "./registry.ts"
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
  StoredDumpResponseBody,
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
  readonly bytes: Uint8Array
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

const headerPairs = (headers: Headers): Array<[string, string]> => {
  const pairs: Array<[string, string]> = []
  headers.forEach((value, name) => { pairs.push([name, value]) })
  return pairs
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
): Promise<ResponseSnapshot> {
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let streamError: string | null = null
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      chunks.push(value)
      total += value.byteLength
    }
  } catch (error) {
    streamError = oneLineError(error)
  } finally { reader.releaseLock() }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return { status, headers, isStream, bytes, payloadBytes: bytes.byteLength, streamError }
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
  ) {
    this.recordId = ulid(startedAt) as DumpRecordId
    this.preparedRequestBody = getDumpStore().prepareRequestBody(requestBody)
    // Preparation starts eagerly and is awaited at terminal persistence. Mark
    // a rejection handled immediately so a long upstream wait cannot surface
    // it as an unhandled promise before `write()` records the dump failure.
    void this.preparedRequestBody.catch(() => {})
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
    if (this.events === null) return
    this.upstreamExchangeCollector ??= collector
  }

  upstreamDialObservation(): ReturnType<typeof createUpstreamDialObservationContext> {
    if (this.events === null) return inactiveObservation
    if (this.upstreamExchangeCollector === null) {
      this.upstreamExchangeCollector = new UpstreamExchangeCollector(this.startedAt)
      this.ownsUpstreamCollector = true
    }
    this.upstreamObservation ??= createUpstreamDialObservationContext(this.upstreamExchangeCollector)
    return this.upstreamObservation
  }

  error(kind: "upstream" | "gateway", upstream?: string): void {
    this.errorMeta = { kind }
    if (upstream !== undefined) this.upstreamId = upstream
  }

  cancelled(): void {
    this.errorMeta = { kind: "cancelled", reason: "client_cancelled" }
  }

  failed(reason: unknown): void {
    if (this.errorMeta?.kind === "cancelled") return
    this.errorMeta = { kind: "failed", reason: typeof reason === "string" ? reason : oneLineError(reason) }
  }

  // Records one protocol frame. Stored as the canonical ProtocolFrame so
  // neither serialization nor parsing happens on this path.
  frame(frame: ProtocolFrame<unknown>): void {
    this.events?.push({ frame, ts: Date.now() - this.startedAt })
  }

  recordSentPayloadBytes(byteLength: number): void {
    this.sentPayloadBytes += byteLength
  }

  success(identity: TelemetryModelIdentity, usage: TokenUsage | null): void {
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
      const bytes = !hasFrames && canonicalBody !== undefined
        ? new TextEncoder().encode(JSON.stringify(canonicalBody)) : new Uint8Array()
      return this.write({ status, headers: headers.map(([k, v]) => [k, v]), isStream: hasFrames,
        bytes, payloadBytes: this.sentPayloadBytes, streamError: null })
    } catch (error) {
      // This API formerly used an async frame: stringify failures must still
      // reject its completion instead of escaping synchronously to the caller.
      this.terminalWrite = Promise.reject(error)
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
  finalize(response: Response): Response
  finalize(...args: [number, ReadonlyArray<readonly [string, string]>] | [Response]): void | Response {
    if (args.length === 2) {
      if (this.terminalWrite !== null) return
      const [status, headers] = args
      waitUntil(this.write({
        status,
        headers: headers.map(([k, v]) => [k, v]),
        isStream: (this.events?.length ?? 0) > 0,
        bytes: new Uint8Array(),
        payloadBytes: this.sentPayloadBytes,
        streamError: null,
      }))
      return
    }

    const [response] = args
    if (this.terminalWrite !== null) {
      return new Response(response.body, {
        status: response.status, statusText: response.statusText, headers: this.withDumpHeaders(response.headers),
      })
    }
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
    this.terminalWrite = drainResponse(forCapture, responseStatus, responseHeaders, isStream)
      .then(this.buildTerminalRecord.bind(this))
      .then(persistTerminalRecord)
    waitUntil(this.terminalWrite)

    return new Response(forClient, {
      status: response.status,
      statusText: response.statusText,
      headers: this.withDumpHeaders(response.headers),
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
    this.terminalWrite ??= this.buildTerminalRecord(response).then(persistTerminalRecord)
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
    const responseBody: StoredDumpResponseBody = events !== null && events.length > 0
      ? { type: "stream", events }
      : response.bytes.byteLength > 0 || response.streamError !== null
        ? response.isStream
          ? { type: "stream", events: [] }
          : { type: "bytes", body: response.bytes }
        : { type: "none" }

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
          headers: this.requestSnapshot.headers.map(([k, v]) => [k, v]),
          body: await preparedRequestBody,
        },
        response: {
          status: response.status,
          headers: response.headers.map(([k, v]) => [k, v]),
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
): DumpAccumulator | null => {
  return openTransportDump({ method, path: c.req.path, headers: c.req.raw.headers }, apiKey, requestBody)
}

/** Plain metadata boundary shared by HTTP and per-message transports. */
export function openTransportDump(
  request: { method: string; path: string; headers: Headers }, apiKey: ApiKey, requestBody: RequestBody,
): DumpAccumulator | null {
  if (apiKey.dumpRetentionSeconds === null) return null
  const requestSnapshot: RequestSnapshot = {
    method: request.method,
    path: request.path,
    headers: headerPairs(request.headers),
    bodyByteLength: requestBody.bytes.byteLength,
    streamError: requestBody.streamError,
  }
  return new DumpAccumulator(apiKey, requestSnapshot, requestBody.bytes, Date.now())
}
