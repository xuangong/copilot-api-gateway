/**
 * Idle keepalive for client-facing SSE streams.
 *
 * An upstream that has already returned HTTP 200 can then think for minutes
 * without emitting a single event. Every hop in between — Bun's own
 * `idleTimeout`, Cloudflare's edge, nginx, corporate proxies — reads that
 * silence as a dead connection and resets it, which surfaces to the SDK as
 * "The socket connection was closed unexpectedly".
 *
 * Unlike the legacy byte-level heartbeat (old repo's src/lib/sse-heartbeat.ts),
 * this operates on the encoder side of the pipeline: callers own the
 * `ReadableStream` controller and enqueue whole frames, so an injected
 * keepalive can never land mid-frame and no frame-boundary scanner is needed.
 */

const ENC = new TextEncoder()

export const SSE_KEEPALIVE_MS = 15_000

/**
 * Anthropic Messages SDKs treat `ping` as a first-class no-op event. The other
 * protocols have no such event, so they get an SSE comment line instead —
 * every conformant parser drops it, whereas a synthesized `response.*` /
 * chunk frame would corrupt the SDK's state machine.
 */
export const MESSAGES_KEEPALIVE_FRAME = 'event: ping\ndata: {"type":"ping"}\n\n'
export const COMMENT_KEEPALIVE_FRAME = ': keepalive\n\n'

export interface SseKeepalive {
  /** Record real stream activity; resets the idle window. */
  touch(): void
  /** Stop emitting. MUST be called before `controller.close()`. */
  stop(): void
}

export function startSseKeepalive(
  controller: Pick<ReadableStreamDefaultController<Uint8Array>, 'enqueue'>,
  frame: string,
  intervalMs: number = SSE_KEEPALIVE_MS,
): SseKeepalive {
  const bytes = ENC.encode(frame)
  let lastActivity = Date.now()
  let stopped = false

  const timer = setInterval(() => {
    if (stopped) return
    if (Date.now() - lastActivity < intervalMs) return
    try {
      controller.enqueue(bytes)
      lastActivity = Date.now()
    } catch {
      // Client already went away and the controller is closed/errored. Nothing
      // left to keep alive; the source loop will unwind on its own.
      stopped = true
      clearInterval(timer)
    }
  }, intervalMs)

  // Node/Bun only: don't hold the process open for a keepalive timer.
  ;(timer as { unref?: () => void }).unref?.()

  return {
    touch() {
      lastActivity = Date.now()
    },
    stop() {
      stopped = true
      clearInterval(timer)
    },
  }
}
