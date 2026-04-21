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
    ? createIdleHeartbeatStream(body, { intervalMs: SSE_HEARTBEAT_MS, heartbeat: OPENAI_KEEPALIVE })
    : null
}

/** Wrap an Anthropic /v1/messages upstream body with idle protocol-ping frames. */
export function wrapAnthropicHeartbeat(
  body: ReadableStream<Uint8Array> | null,
): ReadableStream<Uint8Array> | null {
  return body
    ? createIdleHeartbeatStream(body, { intervalMs: SSE_HEARTBEAT_MS, heartbeat: ANTHROPIC_PING })
    : null
}

export interface IdleHeartbeatOptions {
  /** ms of idle time before injecting a heartbeat byte sequence */
  intervalMs: number
  /** bytes to inject on each idle tick — must be a no-op for the protocol
   * (e.g. SSE comment ": keepalive\n\n", or Anthropic "event: ping\ndata: {}\n\n") */
  heartbeat: Uint8Array
}

export function createIdleHeartbeatStream(
  upstream: ReadableStream<Uint8Array>,
  opts: IdleHeartbeatOptions,
): ReadableStream<Uint8Array> {
  const reader = upstream.getReader()

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        // Keep the same pending readP across timeout loops so we don't
        // create multiple concurrent reads that would orphan chunks.
        let readP = reader.read().then((r) => ({ read: r as ReadableStreamReadResult<Uint8Array> }))
        for (;;) {
          let timer: ReturnType<typeof setTimeout> | undefined
          const timeout = new Promise<"timeout">((resolve) => {
            timer = setTimeout(() => resolve("timeout"), opts.intervalMs)
          })
          const winner = await Promise.race([readP, timeout])
          if (timer) clearTimeout(timer)

          if (winner === "timeout") {
            controller.enqueue(opts.heartbeat)
            continue
          }
          const { done, value } = winner.read
          if (done) {
            controller.close()
            return
          }
          if (value) controller.enqueue(value)
          // Advance to the next read only after the current one resolved
          readP = reader.read().then((r) => ({ read: r as ReadableStreamReadResult<Uint8Array> }))
        }
      } catch (err) {
        controller.error(err)
      }
    },
    async cancel(reason) {
      try { await reader.cancel(reason) } catch { /* ignore */ }
    },
  })
}
