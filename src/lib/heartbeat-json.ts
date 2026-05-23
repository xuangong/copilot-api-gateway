/**
 * Wrap a sync (non-streaming) upstream JSON request so it survives the
 * various ~60s first-byte / read-idle timeouts that exist along the path
 * `client → (any intermediate proxies) → CF Worker → upstream Copilot API`.
 *
 * What this actually defends against (revised):
 *   - Client SDK / HTTP-library `read timeout` while waiting on the first
 *     response byte (typical default in fetch / axios / many Copilot SDKs
 *     is around 60s and applies until the first byte arrives).
 *   - Corporate/ISP/intermediate proxies that drop connections after N
 *     seconds without any bytes in flight.
 *
 * What this does NOT meaningfully defend against:
 *   - Cloudflare's documented HTTP 524 (~100s origin timeout) — that
 *     applies to CF → origin, not to Workers (we ARE the worker).
 *   - The Worker → upstream subrequest being killed by the Workers
 *     runtime for idleness — Workers does not have a published 60s
 *     cap on a single awaited subrequest; long awaits are fine.
 *
 * Earlier revisions of this file blamed "Cloudflare edge ~60s idle
 * timeout" specifically. That attribution was speculative; the real
 * mechanism that gets us out of trouble is simply *starting to flush
 * bytes*. Once any byte is on the wire, almost every read-timeout in
 * the chain stops firing, regardless of which one would have triggered.
 *
 * Applicability: this helper is ONLY for non-streaming JSON paths.
 * Streaming SSE paths have their own keepalive in sse-heartbeat.ts —
 * do NOT layer this on top of an SSE response (the space bytes would
 * land mid-event and break frame parsing).
 *
 * Strategy:
 *   1. Race the upstream Promise against `raceMs` (default 50s — well
 *      below the typical 60s client read timeout).
 *   2. If upstream resolves in time → behave exactly like before:
 *      caller receives the resolved value and builds its own Response.
 *   3. If upstream is still pending → emit a 200 streaming Response with
 *      Content-Type: application/json. We push a single space character
 *      every `heartbeatMs` to keep the connection alive. JSON tolerates
 *      arbitrary leading whitespace, so the final body
 *      (`"   ...   {real json}"`) parses correctly with any standard
 *      JSON parser (Anthropic SDK, OpenAI SDK, fetch().json(), etc.).
 *
 * On upstream error after the race window we still emit 200 + an error
 * JSON body (status code is locked once headers are sent). Callers should
 * treat the error path inside `onResolve` as best-effort logging only.
 */

export type HeartbeatRaceResult<T> =
  | { kind: "fast"; value: T }
  | { kind: "stream"; response: Response }

export interface HeartbeatOptions<T> {
  /** ms before we give up waiting and switch to streaming heartbeat */
  raceMs?: number
  /** ms between space heartbeats once streaming */
  heartbeatMs?: number
  /** called once upstream resolves on the streaming path; for usage / metrics */
  onResolve?: (value: T) => void | Promise<void>
  /** called once upstream rejects on the streaming path */
  onReject?: (err: unknown) => void | Promise<void>
  /** serialize T → string for the streaming body. Default: JSON.stringify */
  serialize?: (value: T) => string
  /** serialize an error → JSON string body for the streaming error path */
  serializeError?: (err: unknown) => string
}

const DEFAULT_RACE_MS = 50_000
const DEFAULT_HEARTBEAT_MS = 15_000

function defaultSerializeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return JSON.stringify({
    type: "error",
    error: { type: "api_error", message: msg },
  })
}

export async function raceWithHeartbeat<T>(
  upstream: Promise<T>,
  opts: HeartbeatOptions<T> = {},
): Promise<HeartbeatRaceResult<T>> {
  const raceMs = opts.raceMs ?? DEFAULT_RACE_MS
  const heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS
  const serialize = opts.serialize ?? ((v: T) => JSON.stringify(v))
  const serializeError = opts.serializeError ?? defaultSerializeError

  // Tag promise outcomes so we can distinguish fast vs slow.
  type Tagged =
    | { kind: "fast"; value: T }
    | { kind: "fast-error"; error: unknown }
    | { kind: "timeout" }

  const tagged: Promise<Tagged> = upstream.then(
    (value) => ({ kind: "fast" as const, value }),
    (error) => ({ kind: "fast-error" as const, error }),
  )

  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout: Promise<Tagged> = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ kind: "timeout" as const }), raceMs)
  })

  const winner = await Promise.race([tagged, timeout])
  if (winner.kind !== "timeout" && timer) clearTimeout(timer)

  if (winner.kind === "fast") {
    return { kind: "fast", value: winner.value }
  }
  if (winner.kind === "fast-error") {
    // Re-throw so caller's existing onError path handles it (preserves status).
    throw winner.error
  }

  // Slow path: switch to streaming heartbeat and resolve later.
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder()
      let closed = false
      const hb = setInterval(() => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(" "))
        } catch {
          // controller already closed; safe to ignore
        }
      }, heartbeatMs)

      // Wait for upstream to truly resolve (we already kicked it off).
      upstream.then(
        async (value) => {
          closed = true
          clearInterval(hb)
          try {
            controller.enqueue(encoder.encode(serialize(value)))
          } catch {
            // ignore
          }
          try {
            controller.close()
          } catch {
            // ignore
          }
          if (opts.onResolve) {
            try {
              await opts.onResolve(value)
            } catch {
              // best-effort
            }
          }
        },
        async (err) => {
          closed = true
          clearInterval(hb)
          try {
            controller.enqueue(encoder.encode(serializeError(err)))
          } catch {
            // ignore
          }
          try {
            controller.close()
          } catch {
            // ignore
          }
          if (opts.onReject) {
            try {
              await opts.onReject(err)
            } catch {
              // best-effort
            }
          }
        },
      )
    },
  })

  const response = new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    },
  })

  return { kind: "stream", response }
}
