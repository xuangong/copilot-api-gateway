// Request-scoped HTTP adapter observation. This module never opens a socket,
// parses a protocol, or drains a stream on the capture branch.

import { Buffer } from "node:buffer"
import { boundedUtf8 } from "./bounded-utf8.ts"

export const UPSTREAM_ATTEMPT_LIMITS = Object.freeze({
  attempts: 8,
  requestPrefix: 64 * 1024,
  responsePrefix: 256 * 1024,
  totalBodyBytes: 1024 * 1024,
  headersPerAttempt: 16 * 1024,
  metadataBytes: 64 * 1024,
})

export type UpstreamAttemptTerminal = "eof" | "cancelled" | "read_error" | "fetch_error" | "not_consumed"
export type UpstreamAttemptErrorCategory = "network" | "abort" | "read" | "unknown"
export type SafeAttemptHeader = readonly ["content-type" | "content-length", string]

export interface CapturedAttemptBody {
  readonly source: "prepared" | "unobserved" | "fetch-body"
  readonly observedBytes: number | null
  readonly totalBytes: number | null
  readonly capturedBytes: number
  readonly prefixBase64: string
  readonly truncated: boolean
  readonly terminal?: UpstreamAttemptTerminal
}

export interface UpstreamAttemptSnapshot {
  readonly id: string
  readonly parentCallId: string
  readonly upstreamId: string
  readonly order: number
  readonly startedOffsetMs: number
  readonly completedOffsetMs: number | null
  readonly method: string
  readonly operation: string
  readonly url: "url_omitted"
  readonly requestHeaders: readonly SafeAttemptHeader[]
  readonly responseHeaders: readonly SafeAttemptHeader[]
  readonly omittedRequestHeaders: number
  readonly omittedResponseHeaders: number
  readonly status: number | null
  readonly representation: "fetch-body"
  readonly request: CapturedAttemptBody
  readonly response: CapturedAttemptBody & { readonly terminal: UpstreamAttemptTerminal }
  readonly errorCategory: UpstreamAttemptErrorCategory | null
}

export interface UpstreamExchanges {
  readonly version: 1
  readonly representation: "fetch-body"
  readonly attempts: readonly UpstreamAttemptSnapshot[]
  readonly omittedAttempts: number
  readonly capturedBodyBytes: number
  // Conservative serialized-metadata byte reservation, excluding body
  // base64. Fixed fields have a per-attempt reservation; each kept header
  // charges its encoded JSON pair plus separator.
  readonly metadataBytes: number
  readonly metadataTruncated: boolean
}

export interface BeginUpstreamAttempt {
  readonly parentCallId: string
  readonly upstreamId: string
  readonly method: string
  readonly operation?: string
  readonly url?: string
  readonly requestHeaders?: Iterable<readonly [string, string]>
  readonly startedAt?: number
}

const SAFE_OPERATIONS = new Set([
  "chat.completions", "responses.create", "messages.create", "embeddings.create",
  "images.generate", "images.edit", "responses.compact", "count_tokens", "search",
])
const SAFE_MEDIA_TYPES = new Set([
  "application/json", "application/octet-stream", "text/event-stream", "text/plain",
  "application/x-www-form-urlencoded", "application/xml", "text/xml",
])
const textEncoder = new TextEncoder()
const byteLength = (value: string): number => textEncoder.encode(value).byteLength
// Fixed field names, numeric counters, delimiters and envelope keys stay
// below this reservation per attempt. Header charges use their serialized
// UTF-8 size, including the array separator. This deliberately overcounts
// the emitted metadata so it cannot cross the 64 KiB budget.
const METADATA_FIXED_RESERVATION_BYTES = 1024
const headerBudgetBytes = (name: string, value: string): number => byteLength(JSON.stringify([name, value])) + 1
const safeCount = (value: number): number => Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, value))
const safeOffset = (now: number, start: number): number =>
  Number.isFinite(now) && Number.isFinite(start) ? safeCount(Math.floor(now - start)) : 0
const safeId = (id: string, omitted: string): string =>
  /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : omitted
const safeMethod = (method: string): string =>
  /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/i.test(method) ? method.toUpperCase() : "OTHER"
const safeStatus = (status: number): number | null =>
  Number.isInteger(status) && status >= 100 && status <= 599 ? status : null
const safeOperation = (operation: string | undefined): string =>
  operation !== undefined && SAFE_OPERATIONS.has(operation) ? operation : "url_omitted"

class BytePrefix {
  private readonly pages: Uint8Array[] = []
  private length = 0
  private ownedLength = 0

  get byteLength(): number { return this.length }

  // Only collector-created exact buffers enter here. External bytes always append.
  own(input: Uint8Array): void {
    if (this.length !== 0) throw new Error("prefix already contains bytes")
    this.pages.length = 0
    if (input.byteLength > 0) this.pages.push(input)
    this.ownedLength = this.length = input.byteLength
  }

  append(input: Uint8Array, limit: number): number {
    let copied = 0
    const allowed = Math.max(0, Math.min(input.byteLength, limit - this.length))
    while (copied < allowed) {
      // The first owned chunk is sealed, including its short tail. Writable
      // pages begin after that chunk and never overwrite or recopy its bytes.
      const writableLength = this.length - this.ownedLength
      const writableIndex = Math.floor(writableLength / 4096)
      const pageIndex = writableIndex + (this.ownedLength > 0 ? 1 : 0)
      const pageOffset = writableLength % 4096
      if (!this.pages[pageIndex]) this.pages.push(new Uint8Array(Math.min(4096, limit - this.ownedLength - writableIndex * 4096)))
      const page = this.pages[pageIndex]
      if (!page) break
      const count = Math.min(allowed - copied, page.byteLength - pageOffset)
      page.set(input.subarray(copied, copied + count), pageOffset)
      this.length += count
      copied += count
    }
    return copied
  }

  base64(): string {
    if (this.length === 0) return ""
    // A single owned chunk or copied page can be viewed without another copy.
    // In either case, exclude unused capacity beyond the captured byte length.
    const page = this.pages[0]!
    if (this.pages.length === 1) return Buffer.from(page.buffer, page.byteOffset, this.length).toString("base64")
    return Buffer.concat(this.pages, this.length).toString("base64")
  }

  release(): void {
    this.pages.length = 0
    this.length = this.ownedLength = 0
  }
}

interface MutableAttempt {
  id: string
  parentCallId: string
  upstreamId: string
  order: number
  startedOffsetMs: number
  completedOffsetMs: number | null
  method: string
  operation: string
  requestHeaders: SafeAttemptHeader[]
  responseHeaders: SafeAttemptHeader[]
  omittedRequestHeaders: number
  omittedResponseHeaders: number
  headerBytes: number
  status: number | null
  requestSource: "prepared" | "unobserved"
  requestObserved: number | null
  requestPrefix: BytePrefix
  responseObserved: number
  responseTotal: number | null
  responsePrefix: BytePrefix
  terminal: UpstreamAttemptTerminal | null
  errorCategory: UpstreamAttemptErrorCategory | null
}

export class UpstreamExchangeCollector {
  private readonly attempts: MutableAttempt[] = []
  private omittedAttempts = 0
  private capturedBodyBytes = 0
  private metadataBytes = 0
  private metadataTruncated = false
  private finished: UpstreamExchanges | null = null

  constructor(private readonly startedAt = Date.now()) {}

  begin(input: BeginUpstreamAttempt): UpstreamAttemptCapture | null {
    if (this.finished !== null) return null
    if (this.attempts.length >= UPSTREAM_ATTEMPT_LIMITS.attempts) {
      this.omittedAttempts = safeCount(this.omittedAttempts + 1)
      return null
    }
    const order = this.attempts.length + 1
    const item: MutableAttempt = {
      id: `attempt-${order}`,
      parentCallId: safeId(input.parentCallId, "call_omitted"),
      upstreamId: safeId(input.upstreamId, "upstream_omitted"),
      order,
      startedOffsetMs: safeOffset(input.startedAt ?? Date.now(), this.startedAt),
      completedOffsetMs: null,
      method: safeMethod(input.method),
      operation: safeOperation(input.operation),
      requestHeaders: [], responseHeaders: [], omittedRequestHeaders: 0, omittedResponseHeaders: 0,
      headerBytes: 0, status: null, requestSource: "unobserved", requestObserved: null,
      requestPrefix: new BytePrefix(), responseObserved: 0, responseTotal: null,
      responsePrefix: new BytePrefix(), terminal: null, errorCategory: null,
    }
    const baseBytes = METADATA_FIXED_RESERVATION_BYTES
    if (this.metadataBytes + baseBytes > UPSTREAM_ATTEMPT_LIMITS.metadataBytes) {
      this.metadataTruncated = true
      this.omittedAttempts = safeCount(this.omittedAttempts + 1)
      return null
    }
    this.metadataBytes += baseBytes
    this.attempts.push(item)
    this.addHeaders(item, input.requestHeaders ?? [], "request")
    return new UpstreamAttemptCapture(this, item)
  }

  private addHeaders(item: MutableAttempt, headers: Iterable<readonly [string, string]>, side: "request" | "response"): void {
    if (this.finished !== null) return
    for (const [rawName, rawValue] of headers) {
      // Skip oversized untrusted strings before lowercasing, splitting or
      // encoding them. Diagnostic capture never allocates a giant header.
      if (rawName.length > 14 || rawValue.length > 128) {
        if (side === "request") item.omittedRequestHeaders = safeCount(item.omittedRequestHeaders + 1)
        else item.omittedResponseHeaders = safeCount(item.omittedResponseHeaders + 1)
        continue
      }
      const name = rawName.toLowerCase()
      let value: string | null = null
      if (name === "content-type") {
        const mediaType = rawValue.split(";", 1)[0]?.trim().toLowerCase()
        if (mediaType && SAFE_MEDIA_TYPES.has(mediaType)) value = mediaType
      } else if (name === "content-length" && /^\d{1,15}$/.test(rawValue)) {
        value = String(Number(rawValue))
      }
      const size = value === null ? 0 : headerBudgetBytes(name, value)
      if (value === null || item.headerBytes + size > UPSTREAM_ATTEMPT_LIMITS.headersPerAttempt
        || this.metadataBytes + size > UPSTREAM_ATTEMPT_LIMITS.metadataBytes) {
        if (side === "request") item.omittedRequestHeaders = safeCount(item.omittedRequestHeaders + 1)
        else item.omittedResponseHeaders = safeCount(item.omittedResponseHeaders + 1)
        if (value !== null) this.metadataTruncated = true
        continue
      }
      const pair: SafeAttemptHeader = [name, value] as SafeAttemptHeader
      if (side === "request") item.requestHeaders.push(pair)
      else item.responseHeaders.push(pair)
      item.headerBytes += size
      this.metadataBytes += size
    }
  }

  private captureLimit(prefix: BytePrefix, perSideLimit: number): number {
    return Math.min(perSideLimit, prefix.byteLength + UPSTREAM_ATTEMPT_LIMITS.totalBodyBytes - this.capturedBodyBytes)
  }

  private capture(prefix: BytePrefix, bytes: Uint8Array, perSideLimit: number): boolean {
    if (this.finished !== null) return true
    const limit = this.captureLimit(prefix, perSideLimit)
    const before = prefix.byteLength
    try {
      prefix.append(bytes, limit)
      return true
    } catch {
      // A diagnostic copy can fail after a page was copied. Keep the global
      // budget aligned with the retained prefix even on that partial failure.
      return false
    } finally {
      this.capturedBodyBytes += prefix.byteLength - before
    }
  }

  observePreparedText(item: MutableAttempt, text: string): void {
    if (this.finished !== null) return
    const prefix = item.requestPrefix
    const available = this.captureLimit(prefix, UPSTREAM_ATTEMPT_LIMITS.requestPrefix) - prefix.byteLength
    const prepared = boundedUtf8(text, available)
    item.requestSource = "prepared"
    item.requestObserved = prepared.totalBytes
    if (prefix.byteLength === 0) {
      prefix.own(prepared.prefix)
      this.capturedBodyBytes += prepared.prefix.byteLength
    } else {
      this.capture(prefix, prepared.prefix, UPSTREAM_ATTEMPT_LIMITS.requestPrefix)
    }
  }

  observePreparedRequest(item: MutableAttempt, input: { readonly prefix: Uint8Array; readonly totalBytes: number }): void {
    if (this.finished !== null) return
    item.requestSource = "prepared"
    item.requestObserved = Number.isSafeInteger(input.totalBytes) && input.totalBytes >= 0 ? input.totalBytes : null
    this.capture(item.requestPrefix, input.prefix, UPSTREAM_ATTEMPT_LIMITS.requestPrefix)
  }

  observeResponse(item: MutableAttempt, status: number, headers: Iterable<readonly [string, string]>, body: ReadableStream<Uint8Array> | null): ReadableStream<Uint8Array> | null {
    if (this.finished !== null) return body
    item.status = safeStatus(status)
    this.addHeaders(item, headers, "response")
    if (body === null) {
      item.responseTotal = 0
      this.end(item, "eof")
      return null
    }
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
    let captureActive = true
    const release = () => { if (reader) { reader.releaseLock(); reader = null } }
    return new ReadableStream<Uint8Array>({
      pull: async controller => {
        let result: Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>
        try {
          reader ??= body.getReader()
          result = await reader.read()
        } catch (error) {
          if (item.terminal !== "cancelled") {
            if (this.finished === null) item.errorCategory = "read"
            this.end(item, "read_error")
            controller.error(error)
          }
          release()
          return
        }
        // Cancelling the source may resolve its pending read as `done`; that
        // is not a source EOF and must not set an exact response total.
        if (item.terminal === "cancelled") { release(); return }
        if (result.done) {
          if (this.finished === null && item.terminal === null) item.responseTotal = item.responseObserved
          this.end(item, "eof")
          release()
          controller.close()
          return
        }
        if (this.finished === null) {
          item.responseObserved = safeCount(item.responseObserved + result.value.byteLength)
          if (captureActive) captureActive = this.capture(item.responsePrefix, result.value, UPSTREAM_ATTEMPT_LIMITS.responsePrefix)
        }
        controller.enqueue(result.value)
      },
      cancel: async reason => {
        this.end(item, "cancelled")
        try {
          reader ??= body.getReader()
          await reader.cancel(reason)
        } finally { release() }
      },
    }, { highWaterMark: 0 })
  }

  fetchError(item: MutableAttempt, category: UpstreamAttemptErrorCategory): void {
    if (this.finished !== null) return
    item.errorCategory = category === "network" || category === "abort" ? category : "unknown"
    this.end(item, "fetch_error")
  }

  private end(item: MutableAttempt, terminal: UpstreamAttemptTerminal, at = Date.now()): void {
    if (this.finished !== null || item.terminal !== null) return
    item.terminal = terminal
    item.completedOffsetMs = safeOffset(at, this.startedAt)
  }

  finish(at = Date.now()): UpstreamExchanges {
    if (this.finished !== null) return this.finished
    for (const item of this.attempts) {
      if (item.terminal === null) this.end(item, "not_consumed", at)
    }
    const attempts = this.attempts.map(item => {
      const request: CapturedAttemptBody = Object.freeze({
        source: item.requestSource, observedBytes: item.requestObserved,
        totalBytes: item.requestObserved, capturedBytes: item.requestPrefix.byteLength,
        prefixBase64: item.requestPrefix.base64(),
        truncated: item.requestObserved !== null && item.requestObserved > item.requestPrefix.byteLength,
      })
      const response = Object.freeze({
        source: "fetch-body" as const, observedBytes: item.responseObserved,
        totalBytes: item.responseTotal, capturedBytes: item.responsePrefix.byteLength,
        prefixBase64: item.responsePrefix.base64(),
        truncated: item.responseObserved > item.responsePrefix.byteLength,
        terminal: item.terminal ?? "not_consumed",
      })
      const freezePairs = (pairs: SafeAttemptHeader[]): readonly SafeAttemptHeader[] =>
        Object.freeze(pairs.map(pair => Object.freeze([...pair]) as SafeAttemptHeader))
      return Object.freeze({
        id: item.id, parentCallId: item.parentCallId, upstreamId: item.upstreamId,
        order: item.order, startedOffsetMs: item.startedOffsetMs,
        completedOffsetMs: item.completedOffsetMs, method: item.method, operation: item.operation,
        url: "url_omitted" as const,
        requestHeaders: freezePairs(item.requestHeaders), responseHeaders: freezePairs(item.responseHeaders),
        omittedRequestHeaders: item.omittedRequestHeaders, omittedResponseHeaders: item.omittedResponseHeaders,
        status: item.status, representation: "fetch-body" as const, request, response,
        errorCategory: item.errorCategory,
      })
    })
    this.finished = Object.freeze({
      version: 1 as const, representation: "fetch-body" as const,
      attempts: Object.freeze(attempts), omittedAttempts: this.omittedAttempts,
      capturedBodyBytes: this.capturedBodyBytes, metadataBytes: this.metadataBytes,
      metadataTruncated: this.metadataTruncated,
    })
    // Publish only after every conversion succeeds. Captures and pending stream
    // callbacks can still retain an item, so release its pages in place.
    for (const item of this.attempts) {
      item.requestPrefix.release()
      item.responsePrefix.release()
    }
    return this.finished
  }
}

export class UpstreamAttemptCapture {
  constructor(private readonly collector: UpstreamExchangeCollector, private readonly item: MutableAttempt) {}
  get id(): string { return this.item.id }
  observePreparedText(text: string): void {
    this.collector.observePreparedText(this.item, text)
  }
  observePreparedRequest(input: { readonly prefix: Uint8Array; readonly totalBytes: number }): void {
    this.collector.observePreparedRequest(this.item, input)
  }
  observeResponse(status: number, headers: Iterable<readonly [string, string]>, body: ReadableStream<Uint8Array> | null): ReadableStream<Uint8Array> | null {
    return this.collector.observeResponse(this.item, status, headers, body)
  }
  fetchError(category: UpstreamAttemptErrorCategory = "unknown"): void {
    this.collector.fetchError(this.item, category)
  }
}

// The storage boundary rebuilds the envelope from known fields. A caller
// cannot smuggle arbitrary object keys, headers, URL components or messages
// into the file by constructing a lookalike TypeScript value.
export function safeUpstreamExchangesForPersistence(input: unknown): UpstreamExchanges {
  const object = (value: unknown): Record<string, unknown> => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid upstream exchange shape")
    return value as Record<string, unknown>
  }
  const count = (value: unknown, maximum: number): number => {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maximum) throw new Error("invalid upstream exchange count")
    return value
  }
  const optionalCount = (value: unknown, maximum: number): number | null => value === null ? null : count(value, maximum)
  const token = (value: unknown, omitted: string): string => {
    if (typeof value !== "string" || (value !== omitted && !/^[A-Za-z0-9_-]{1,64}$/.test(value))) throw new Error("invalid upstream exchange token")
    return value
  }
  const headers = (value: unknown): { pairs: SafeAttemptHeader[]; bytes: number } => {
    if (!Array.isArray(value)) throw new Error("invalid upstream headers")
    const pairs: SafeAttemptHeader[] = []
    let bytes = 0
    for (const pair of value) {
      if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string" || typeof pair[1] !== "string") throw new Error("invalid upstream header")
      const [name, content] = pair
      if (name === "content-type") {
        if (!SAFE_MEDIA_TYPES.has(content)) throw new Error("unsafe upstream content type")
      } else if (name === "content-length") {
        if (!/^\d{1,15}$/.test(content) || String(Number(content)) !== content) throw new Error("unsafe upstream content length")
      } else throw new Error("unsafe upstream header")
      bytes += headerBudgetBytes(name, content)
      if (bytes > UPSTREAM_ATTEMPT_LIMITS.headersPerAttempt) throw new Error("upstream header budget exceeded")
      pairs.push([name, content] as SafeAttemptHeader)
    }
    return { pairs, bytes }
  }
  const body = (value: unknown, side: "request" | "response") => {
    const raw = object(value)
    const source = raw.source
    if (side === "request" ? source !== "prepared" && source !== "unobserved" : source !== "fetch-body") throw new Error("invalid upstream body source")
    const observedBytes = optionalCount(raw.observedBytes, Number.MAX_SAFE_INTEGER)
    const totalBytes = optionalCount(raw.totalBytes, Number.MAX_SAFE_INTEGER)
    const capturedBytes = count(raw.capturedBytes, side === "request" ? UPSTREAM_ATTEMPT_LIMITS.requestPrefix : UPSTREAM_ATTEMPT_LIMITS.responsePrefix)
    const prefixBase64 = raw.prefixBase64
    const maxEncoded = Math.ceil(capturedBytes / 3) * 4
    if (typeof prefixBase64 !== "string" || prefixBase64.length !== maxEncoded) throw new Error("invalid upstream body prefix")
    const padding = prefixBase64.endsWith("==") ? 2 : prefixBase64.endsWith("=") ? 1 : 0
    if (prefixBase64.length / 4 * 3 - padding !== capturedBytes
      || /[^A-Za-z0-9+/]/.test(prefixBase64.slice(0, prefixBase64.length - padding))) throw new Error("invalid upstream body prefix")
    if (raw.truncated !== (observedBytes !== null && observedBytes > capturedBytes)) throw new Error("invalid upstream truncation")
    if (side === "request") {
      if (source === "unobserved" && (observedBytes !== null || totalBytes !== null || capturedBytes !== 0)) throw new Error("unobserved request has bytes")
      if (source === "prepared" && totalBytes !== observedBytes) throw new Error("prepared request count mismatch")
      return { source: source as "prepared" | "unobserved", observedBytes, totalBytes, capturedBytes, prefixBase64, truncated: raw.truncated as boolean }
    }
    const terminal = raw.terminal
    if (terminal !== "eof" && terminal !== "cancelled" && terminal !== "read_error" && terminal !== "fetch_error" && terminal !== "not_consumed") throw new Error("invalid upstream terminal")
    if (observedBytes === null || capturedBytes > observedBytes || (terminal === "eof" ? totalBytes !== observedBytes : totalBytes !== null)) throw new Error("invalid upstream response count")
    return { source: "fetch-body" as const, observedBytes, totalBytes, capturedBytes, prefixBase64, truncated: raw.truncated as boolean, terminal }
  }
  const raw = object(input)
  if (raw.version !== 1 || raw.representation !== "fetch-body" || !Array.isArray(raw.attempts)
    || raw.attempts.length > UPSTREAM_ATTEMPT_LIMITS.attempts) throw new Error("invalid upstream exchange version")
  const attempts: UpstreamAttemptSnapshot[] = []
  let capturedBodyBytes = 0
  let metadataBytes = 0
  for (const value of raw.attempts) {
    const item = object(value)
    const id = token(item.id, "attempt_omitted")
    const parentCallId = token(item.parentCallId, "call_omitted")
    const upstreamId = token(item.upstreamId, "upstream_omitted")
    const order = count(item.order, UPSTREAM_ATTEMPT_LIMITS.attempts)
    const startedOffsetMs = count(item.startedOffsetMs, Number.MAX_SAFE_INTEGER)
    const completedOffsetMs = optionalCount(item.completedOffsetMs, Number.MAX_SAFE_INTEGER)
    if (order !== attempts.length + 1 || id !== `attempt-${order}`) throw new Error("invalid upstream attempt order")
    const method = item.method
    if (typeof method !== "string" || safeMethod(method) !== method) throw new Error("invalid upstream method")
    const operation = item.operation
    if (typeof operation !== "string" || (operation !== "url_omitted" && !SAFE_OPERATIONS.has(operation))) throw new Error("unsafe upstream operation")
    if (item.url !== "url_omitted" || item.representation !== "fetch-body") throw new Error("unsafe upstream URL")
    const requestHeaders = headers(item.requestHeaders)
    const responseHeaders = headers(item.responseHeaders)
    if (requestHeaders.bytes + responseHeaders.bytes > UPSTREAM_ATTEMPT_LIMITS.headersPerAttempt) throw new Error("upstream header budget exceeded")
    const omittedRequestHeaders = count(item.omittedRequestHeaders, Number.MAX_SAFE_INTEGER)
    const omittedResponseHeaders = count(item.omittedResponseHeaders, Number.MAX_SAFE_INTEGER)
    const status = optionalCount(item.status, 599)
    if (status !== null && status < 100) throw new Error("invalid upstream status")
    const request = body(item.request, "request") as CapturedAttemptBody
    const response = body(item.response, "response") as CapturedAttemptBody & { terminal: UpstreamAttemptTerminal }
    capturedBodyBytes += request.capturedBytes + response.capturedBytes
    const errorCategory = item.errorCategory
    if (errorCategory !== null && errorCategory !== "network" && errorCategory !== "abort" && errorCategory !== "read" && errorCategory !== "unknown") throw new Error("unsafe upstream error")
    metadataBytes += METADATA_FIXED_RESERVATION_BYTES + requestHeaders.bytes + responseHeaders.bytes
    attempts.push({
      id, parentCallId, upstreamId, order, startedOffsetMs, completedOffsetMs, method, operation,
      url: "url_omitted", requestHeaders: requestHeaders.pairs, responseHeaders: responseHeaders.pairs,
      omittedRequestHeaders, omittedResponseHeaders, status, representation: "fetch-body",
      request, response, errorCategory,
    })
  }
  if (capturedBodyBytes > UPSTREAM_ATTEMPT_LIMITS.totalBodyBytes || raw.capturedBodyBytes !== capturedBodyBytes
    || metadataBytes > UPSTREAM_ATTEMPT_LIMITS.metadataBytes || raw.metadataBytes !== metadataBytes) throw new Error("upstream exchange budget mismatch")
  const omittedAttempts = count(raw.omittedAttempts, Number.MAX_SAFE_INTEGER)
  if (typeof raw.metadataTruncated !== "boolean") throw new Error("invalid upstream metadata truncation")
  return {
    version: 1, representation: "fetch-body", attempts, omittedAttempts,
    capturedBodyBytes, metadataBytes, metadataTruncated: raw.metadataTruncated,
  }
}
