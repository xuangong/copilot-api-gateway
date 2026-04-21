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

/** Wrap an Anthropic /v1/messages upstream body with idle protocol-ping frames.
 *
 * Also strips the trailing `data: [DONE]\n\n` frame that Copilot upstream
 * appends (OpenAI convention). Anthropic SDKs try to JSON.parse the data
 * payload of every `data:` frame and choke on the literal `[DONE]`, dropping
 * the entire message and leaving clients (e.g. Claude Code) in an "Idle"
 * state with no visible reply. The Anthropic protocol terminates with
 * `event: message_stop`, not `[DONE]`, so this frame is purely noise. */
export function wrapAnthropicHeartbeat(
  body: ReadableStream<Uint8Array> | null,
): ReadableStream<Uint8Array> | null {
  if (!body) return null
  const recovered = recoverAnthropicMidStreamError(body)
  const heartbeated = createIdleHeartbeatStream(recovered, {
    intervalMs: SSE_HEARTBEAT_MS,
    heartbeat: ANTHROPIC_PING,
    tag: "anthropic",
  })
  return heartbeated.pipeThrough(stripAnthropicDoneFrameTransform())
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

/**
 * Strip the trailing `data: [DONE]\n\n` frame (and CRLF variant) emitted by
 * Copilot upstream on Anthropic-format streams. This frame is OpenAI's
 * terminator convention; the Anthropic protocol terminates with
 * `event: message_stop`. Anthropic SDKs JSON.parse every `data:` payload,
 * so the literal `[DONE]` triggers SyntaxError and the SDK silently drops
 * the message — clients see "Idle" with no reply.
 *
 * Operates on whole-frame boundaries because the upstream wrapper guarantees
 * downstream chunks always end at a frame edge. We still scan within each
 * chunk in case multiple complete frames arrive together.
 */
function stripAnthropicDoneFrameTransform(): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder("utf-8")
  const encoder = new TextEncoder()
  // Match a complete `data: [DONE]` SSE frame, optional CR before LF, with
  // its terminating blank line. Allows the trailing terminator to be either
  // \n\n or \r\n\r\n.
  const DONE_FRAME = /data:\s*\[DONE\]\s*\r?\n\r?\n/g
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const text = decoder.decode(chunk, { stream: false })
      if (!text.includes("[DONE]")) {
        controller.enqueue(chunk)
        return
      }
      const filtered = text.replace(DONE_FRAME, "")
      if (filtered.length > 0) {
        controller.enqueue(encoder.encode(filtered))
      }
    },
  })
}

/**
 * Wrap an Anthropic upstream so that if it errors mid-stream we emit a
 * synthetic graceful close instead of propagating the error to the SDK.
 *
 * Why this exists (CFW-specific, unavoidable):
 *   We run on Cloudflare Workers (serverless). CF enforces a hard ~120s cap
 *   on outgoing `fetch()` connections — long-thinking Copilot streams that
 *   exceed this limit are cut by the platform with "Network connection lost.",
 *   regardless of what the worker or upstream does. There is no way to
 *   extend the limit; mid-stream cuts on long replies are a fact of life.
 *
 * What goes wrong without this wrapper:
 *   The Anthropic SDK marks the entire response as failed on any stream
 *   error, discarding all already-rendered text. Clients (Claude Code) show
 *   "Idle" with no visible reply, even though most of the answer was
 *   delivered. The user sees nothing.
 *
 * Fix:
 *   On error, append `content_block_stop` (for any open block) +
 *   `message_delta { stop_reason: "end_turn" }` + `message_stop`. The SDK
 *   sees a complete protocol → finalizes the partial response → user keeps
 *   what they already received.
 *
 * Safety when upstream finishes cleanly:
 *   No-op. We only synthesize on caught error. If `done` is reached normally,
 *   we just close. We also skip synthesis when we've already seen a real
 *   `message_stop` (e.g. error fires post-terminator) or never saw
 *   `message_start` (no partial content worth preserving). So this is safe
 *   to apply unconditionally to every Anthropic stream.
 *
 * Tracks open content blocks via regex scan of `content_block_start` /
 * `content_block_stop` event markers in the byte stream.
 */
function recoverAnthropicMidStreamError(
  upstream: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const reader = upstream.getReader()
  const encoder = new TextEncoder()
  const decoder = new TextDecoder("utf-8", { fatal: false })
  // Indices of content blocks we've seen `content_block_start` for and
  // not yet seen `content_block_stop` for.
  const openBlocks = new Set<number>()
  // Have we seen `message_start`? If not, the synthetic close is meaningless.
  let sawMessageStart = false
  // Have we already seen `message_stop`? If yes, no synthetic close needed.
  let sawMessageStop = false

  const scanFrames = (chunkText: string): void => {
    // Crude but sufficient: regex-scan for the event markers. Frames are
    // already at boundaries thanks to upstream chunking.
    if (chunkText.includes("event: message_start")) sawMessageStart = true
    if (chunkText.includes("event: message_stop")) sawMessageStop = true
    // content_block_start frames carry an "index" field in their data JSON.
    const startRe = /event: content_block_start\s*\ndata: ([^\n]+)/g
    let m: RegExpExecArray | null
    while ((m = startRe.exec(chunkText)) !== null) {
      try {
        const data = JSON.parse(m[1] ?? "") as { index?: number }
        if (typeof data.index === "number") openBlocks.add(data.index)
      } catch { /* ignore malformed */ }
    }
    const stopRe = /event: content_block_stop\s*\ndata: ([^\n]+)/g
    while ((m = stopRe.exec(chunkText)) !== null) {
      try {
        const data = JSON.parse(m[1] ?? "") as { index?: number }
        if (typeof data.index === "number") openBlocks.delete(data.index)
      } catch { /* ignore malformed */ }
    }
  }

  const synthesizeClose = (): Uint8Array => {
    const parts: Array<string> = []
    // Close any open content blocks first.
    for (const idx of openBlocks) {
      parts.push(
        `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: idx })}\n\n`,
      )
    }
    // Synthetic message_delta with stop_reason so SDK can finalize.
    parts.push(
      `event: message_delta\ndata: ${JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 0 },
      })}\n\n`,
    )
    // Terminal message_stop event.
    parts.push(
      `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
    )
    return encoder.encode(parts.join(""))
  }

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) {
            controller.close()
            return
          }
          if (value && value.length > 0) {
            try {
              scanFrames(decoder.decode(value, { stream: true }))
            } catch { /* best-effort scan */ }
            controller.enqueue(value)
          }
        }
      } catch (err) {
        // Upstream errored mid-stream. If we'd already seen message_stop or
        // never saw message_start (no useful partial content), just close.
        if (sawMessageStop || !sawMessageStart) {
          try {
            console.log(JSON.stringify({
              evt: "anthropic_recover_skip",
              reason: sawMessageStop ? "after_stop" : "before_start",
              err: err instanceof Error ? err.message : String(err),
            }))
          } catch { /* best-effort */ }
          controller.close()
          return
        }
        // Synthesize graceful close so SDK keeps already-streamed content.
        try {
          console.log(JSON.stringify({
            evt: "anthropic_recover_synth",
            openBlocks: openBlocks.size,
            err: err instanceof Error ? err.message : String(err),
          }))
        } catch { /* best-effort */ }
        try {
          controller.enqueue(synthesizeClose())
        } catch { /* downstream may already be gone */ }
        controller.close()
      }
    },
    async cancel(reason) {
      try { await reader.cancel(reason) } catch { /* ignore */ }
    },
  })
}
