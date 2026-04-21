// src/lib/sse-heartbeat.ts

/** Default idle interval (ms) before injecting a keepalive byte sequence.
 * Tuned to fire well before Cloudflare edge's ~60s idle close. */
export const SSE_HEARTBEAT_MS = 15_000

const OPENAI_KEEPALIVE = new TextEncoder().encode(": keepalive\n\n")
const ANTHROPIC_PING = new TextEncoder().encode("event: ping\ndata: {}\n\n")

/** Wrap an OpenAI/Responses/Gemini-SSE upstream body with idle keepalive comments. */
export function wrapOpenAIHeartbeat(
  body: ReadableStream<Uint8Array> | null,
): ReadableStream<Uint8Array> | null {
  return body
    ? createIdleHeartbeatStream(body, { intervalMs: SSE_HEARTBEAT_MS, heartbeat: OPENAI_KEEPALIVE, tag: "openai" })
    : null
}

/** Wrap an Anthropic /v1/messages upstream body with idle protocol-ping frames. */
export function wrapAnthropicHeartbeat(
  body: ReadableStream<Uint8Array> | null,
): ReadableStream<Uint8Array> | null {
  return body
    ? createIdleHeartbeatStream(body, { intervalMs: SSE_HEARTBEAT_MS, heartbeat: ANTHROPIC_PING, tag: "anthropic" })
    : null
}

export interface IdleHeartbeatOptions {
  /** ms of idle time before injecting a heartbeat byte sequence */
  intervalMs: number
  /** bytes to inject on each idle tick — must be a no-op for the protocol
   * (e.g. SSE comment ": keepalive\n\n", or Anthropic "event: ping\ndata: {}\n\n") */
  heartbeat: Uint8Array
  /** optional label for end-of-stream diagnostics in CFW logs */
  tag?: string
}

/**
 * Wrap an SSE upstream so heartbeats can be injected during idle gaps without
 * ever splicing into the middle of a frame.
 *
 * Strategy: buffer upstream bytes and only emit downstream up to (and including)
 * a complete-frame boundary ("\n\n" or "\r\n\r\n"). Heartbeats are emitted only
 * between complete frames — never between two halves of one upstream chunk that
 * happens to span the network. Any upstream chunk that ends mid-frame stays in
 * the internal buffer until its terminator arrives.
 *
 * This makes the previous "Bad control character in JSON" class of bugs
 * structurally impossible: downstream always sees whole SSE frames.
 */
export function createIdleHeartbeatStream(
  upstream: ReadableStream<Uint8Array>,
  opts: IdleHeartbeatOptions,
): ReadableStream<Uint8Array> {
  const reader = upstream.getReader()

  // Pending bytes from upstream that haven't yet reached a frame terminator.
  // Held back from downstream so we never emit a partial frame.
  let pending = new Uint8Array(0)

  const concat = (a: Uint8Array, b: Uint8Array): Uint8Array => {
    const out = new Uint8Array(a.length + b.length)
    out.set(a, 0)
    out.set(b, a.length)
    return out
  }

  /** Index just past the last frame terminator in `buf` (i.e. length of the
   * "complete-frames prefix"), or 0 if buf has no terminator at all. */
  const lastFrameEnd = (buf: Uint8Array): number => {
    let end = 0
    for (let i = 1; i < buf.length; i++) {
      // "\n\n"
      if (buf[i] === 0x0a && buf[i - 1] === 0x0a) {
        end = i + 1
      } else if (
        // "\r\n\r\n"
        i >= 3 &&
        buf[i] === 0x0a &&
        buf[i - 1] === 0x0d &&
        buf[i - 2] === 0x0a &&
        buf[i - 3] === 0x0d
      ) {
        end = i + 1
      }
    }
    return end
  }

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      // Diagnostic: ring buffer of last ~1KB of upstream bytes so we can
      // see, on stream close, whether upstream actually sent a final frame
      // terminator and what the last event type was. Logged only on close
      // (no per-chunk logging) and capped to 1024 bytes total.
      const TAIL_CAP = 1024
      let tail = new Uint8Array(0)
      const recordTail = (chunk: Uint8Array): void => {
        const merged = tail.length === 0 ? chunk : concat(tail, chunk)
        tail = merged.length <= TAIL_CAP
          ? merged
          : merged.subarray(merged.length - TAIL_CAP)
      }
      let totalBytes = 0
      let chunkCount = 0
      const startedAt = Date.now()

      try {
        // Keep the same pending readP across timer loops so we never start
        // two concurrent reads that would orphan a chunk.
        let readP = reader.read().then((r) => ({ read: r as ReadableStreamReadResult<Uint8Array> }))
        for (;;) {
          let timer: ReturnType<typeof setTimeout> | undefined
          const timeout = new Promise<"timeout">((resolve) => {
            timer = setTimeout(() => resolve("timeout"), opts.intervalMs)
          })
          const winner = await Promise.race([readP, timeout])
          if (timer) clearTimeout(timer)

          if (winner === "timeout") {
            // Safe at any time: pending is held back until a frame terminator,
            // so the downstream byte stream is always at a frame edge here.
            controller.enqueue(opts.heartbeat)
            continue
          }
          const { done, value } = winner.read
          if (done) {
            // Flush any remaining bytes (best-effort: protocol-illegal partial
            // frame is still better than silently dropping the model's output).
            if (pending.length > 0) {
              controller.enqueue(pending)
              pending = new Uint8Array(0)
            }
            // End-of-stream diagnostic: log last 1KB of upstream so we can
            // tell whether upstream sent a proper terminating frame or
            // truncated mid-event. Tag + bytes + chunk count + duration.
            try {
              const tailStr = new TextDecoder("utf-8", { fatal: false }).decode(tail)
              console.log(JSON.stringify({
                evt: "sse_heartbeat_eos",
                tag: opts.tag ?? "unknown",
                bytes: totalBytes,
                chunks: chunkCount,
                durMs: Date.now() - startedAt,
                tailLen: tail.length,
                tail: tailStr,
              }))
            } catch { /* best-effort */ }
            controller.close()
            return
          }
          if (value && value.length > 0) {
            chunkCount += 1
            totalBytes += value.length
            recordTail(value)
            pending = pending.length === 0 ? value : concat(pending, value)
            const cut = lastFrameEnd(pending)
            if (cut > 0) {
              controller.enqueue(pending.subarray(0, cut))
              pending = pending.subarray(cut)
            }
            // If cut === 0, the whole chunk is mid-frame; hold it.
          }
          // Advance read only after the prior one resolved.
          readP = reader.read().then((r) => ({ read: r as ReadableStreamReadResult<Uint8Array> }))
        }
      } catch (err) {
        try {
          const tailStr = new TextDecoder("utf-8", { fatal: false }).decode(tail)
          console.log(JSON.stringify({
            evt: "sse_heartbeat_err",
            tag: opts.tag ?? "unknown",
            bytes: totalBytes,
            chunks: chunkCount,
            durMs: Date.now() - startedAt,
            tail: tailStr,
            err: err instanceof Error ? err.message : String(err),
          }))
        } catch { /* best-effort */ }
        controller.error(err)
      }
    },
    async cancel(reason) {
      try { await reader.cancel(reason) } catch { /* ignore */ }
    },
  })
}
