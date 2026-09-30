import type { StoredDumpRecord, StoredDumpResponseBody } from "./types.ts"

const OMITTED = "sensitive_or_opaque_content" as const
const SAFE_MEDIA_TYPES = new Set([
  "application/json", "application/x-www-form-urlencoded", "application/octet-stream",
  "text/plain", "text/event-stream", "text/html", "text/xml", "application/xml",
])
const SAFE_EVENT_NAMES = new Set([
  "response.created", "response.in_progress", "response.completed", "response.failed",
  "response.output_text.delta", "response.output_text.done", "message_start",
  "message_stop", "content_block_start", "content_block_delta", "content_block_stop",
])

const captureStatus = (capture: StoredDumpRecord["meta"]["capture"]) => {
  if (capture?.state !== "omitted") return null
  const reason = capture.reason
  return reason === "capture_limit" || reason === "environment_limit" || reason === "frame_limit" || reason === "unsupported_payload"
    ? { state: "omitted" as const, reason } : null
}

const finiteNonnegative = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null

const status = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599 ? value : null

const method = (value: unknown): string | null =>
  typeof value === "string" && /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/i.test(value) ? value.toUpperCase() : null

const safeHeaders = (headers: ReadonlyArray<readonly [string, string]>): Array<[string, string]> => {
  const safe: Array<[string, string]> = []
  for (const [name, value] of headers) {
    const lower = name.toLowerCase()
    if (lower === "content-type") {
      const mediaType = value.trim().split(";", 1)[0]?.toLowerCase()
      if (mediaType && SAFE_MEDIA_TYPES.has(mediaType)) safe.push(["content-type", mediaType])
    }
  }
  return safe
}

const responseBody = (body: StoredDumpResponseBody) => {
  if (body.type === "none") return { type: "none" as const }
  if (body.type === "bytes") return {
    type: "bytes" as const,
    byteLength: body.body.byteLength,
    representation: "captured_bytes" as const,
    sourceEncoding: "not_captured" as const,
    omitted: OMITTED,
  }
  const eventNames = body.events.flatMap(({ frame }) => {
    if (frame.type !== "event" || !frame.event || typeof frame.event !== "object") return []
    const value = "type" in frame.event ? frame.event.type : undefined
    return typeof value === "string" && SAFE_EVENT_NAMES.has(value) ? [value] : []
  })
  return {
    type: "stream" as const,
    eventCount: body.events.length,
    eventNames: [...new Set(eventNames)],
    lastEventOffsetMs: finiteNonnegative(body.events.at(-1)?.ts),
    representation: "canonical_frames" as const,
    sourceEncoding: "not_captured" as const,
    completion: "unknown" as const,
    truncation: "not_captured" as const,
    omitted: OMITTED,
  }
}

export function dumpRecordToExport(original: StoredDumpRecord) {
  const record = structuredClone(original)
  return {
    format: "gateway-dump-redacted-v1" as const,
    meta: {
      id: /^[A-Za-z0-9_-]{1,64}$/.test(record.meta.id) ? record.meta.id : null,
      startedAt: finiteNonnegative(record.meta.startedAt),
      completedAt: finiteNonnegative(record.meta.completedAt),
      method: method(record.meta.method),
      status: status(record.meta.status),
      inputTokens: finiteNonnegative(record.meta.inputTokens),
      outputTokens: finiteNonnegative(record.meta.outputTokens),
      requestBytes: finiteNonnegative(record.meta.requestBytes),
      responseBytes: finiteNonnegative(record.meta.responseBytes),
      durationMs: finiteNonnegative(record.meta.durationMs),
      errorCategory: record.meta.error?.kind === "upstream" || record.meta.error?.kind === "gateway"
        || record.meta.error?.kind === "failed" || record.meta.error?.kind === "cancelled"
        ? record.meta.error.kind : null,
      capture: captureStatus(record.meta.capture),
    },
    request: {
      method: method(record.request.method),
      headers: safeHeaders(record.request.headers),
      body: {
        type: "bytes" as const,
        byteLength: record.request.body.byteLength,
        representation: "captured_bytes" as const,
        sourceEncoding: "not_captured" as const,
        omitted: OMITTED,
      },
    },
    response: {
      status: status(record.response.status),
      headers: safeHeaders(record.response.headers),
      body: responseBody(record.response.body),
    },
  }
}
