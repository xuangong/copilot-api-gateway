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
import type { DumpRecordId, UpstreamId } from "../../repo/branded-ids.ts"
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

export class DumpAccumulator {
  private readonly events: DumpStreamEvent[] = []
  private sentPayloadBytes = 0
  private model: string | null = null
  private upstreamId: string | null = null
  private inputTokens: number | null = null
  private outputTokens: number | null = null
  private errorMeta: DumpErrorMeta | null = null
  private readonly preparedRequestBody: Promise<PreparedDumpRequestBody>
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

  error(kind: "upstream" | "gateway", upstream?: string): void {
    this.errorMeta = { kind }
    if (upstream !== undefined) this.upstreamId = upstream
  }

  failed(reason: unknown): void {
    this.errorMeta = { kind: "failed", reason: typeof reason === "string" ? reason : oneLineError(reason) }
  }

  // Records one protocol frame. Stored as the canonical ProtocolFrame so
  // neither serialization nor parsing happens on this path.
  frame(frame: ProtocolFrame<unknown>): void {
    this.events.push({ frame, ts: Date.now() - this.startedAt })
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
  finalize(status: number, headers: ReadonlyArray<readonly [string, string]>): void
  finalize(response: Response): Response
  finalize(...args: [number, ReadonlyArray<readonly [string, string]>] | [Response]): void | Response {
    if (args.length === 2) {
      const [status, headers] = args
      waitUntil(this.write({
        status,
        headers: headers.map(([k, v]) => [k, v]),
        isStream: this.events.length > 0,
        bytes: new Uint8Array(),
        payloadBytes: this.sentPayloadBytes,
        streamError: null,
      }))
      return
    }

    const [response] = args
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
    waitUntil((async () => {
      const reader = forCapture.getReader()
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
      } catch (err) {
        streamError = oneLineError(err)
      }
      const bytes = new Uint8Array(total)
      let offset = 0
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
      await this.write({
        status: responseStatus,
        headers: responseHeaders,
        isStream,
        bytes,
        payloadBytes: bytes.byteLength,
        streamError,
      })
    })())

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

  private async write(response: ResponseSnapshot): Promise<void> {
    // Use the record id allocated at ctx construction so the
    // `X-Dump-Record-Id` header the client already received matches the row
    // this write persists.
    const completedAt = Date.now()
    const recordId = this.recordId

    // Prefer the accumulator's frame log so dumps reflect the gateway's
    // frame sequence regardless of negotiated wire shape; passthrough
    // endpoints with no frames fall back to captured bytes.
    const responseBody: StoredDumpResponseBody = this.events.length > 0
      ? { type: "stream", events: this.events }
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
      const record: DumpWriteRecord = {
        meta,
        request: {
          method: this.requestSnapshot.method,
          path: this.requestSnapshot.path,
          headers: this.requestSnapshot.headers.map(([k, v]) => [k, v]),
          body: await this.preparedRequestBody,
        },
        response: {
          status: response.status,
          headers: response.headers.map(([k, v]) => [k, v]),
          body: responseBody,
        },
      }
      await getDumpStore().put(this.apiKey.id, record)
      await getDumpBroker().publish(this.apiKey.id, meta)
    } catch (err) {
      console.error(`[dump] write failed for key=${this.apiKey.id} record=${recordId}`, oneLineError(err))
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
  if (apiKey.dumpRetentionSeconds === null) return null
  const requestSnapshot: RequestSnapshot = {
    method,
    path: c.req.path,
    headers: headerPairs(c.req.raw.headers),
    bodyByteLength: requestBody.bytes.byteLength,
    streamError: requestBody.streamError,
  }
  return new DumpAccumulator(apiKey, requestSnapshot, requestBody.bytes, Date.now())
}
