/**
 * Strip `thinking_delta` events from an Anthropic Messages SSE stream while
 * preserving the surrounding block structure (`content_block_start` /
 * `content_block_stop`) and any `signature_delta` events.
 *
 * Why this exists:
 *   When we promote the request's `thinking.display` from "omitted" to
 *   "summarized" (see src/transforms/promote-thinking-display.ts), the
 *   upstream begins streaming token-level thinking content. The downstream
 *   client did not ask for that — it asked for "omitted". We honor the
 *   client's request by removing the thinking text after it has done its
 *   job of keeping bytes flowing on the wire.
 *
 * What "omitted" semantically expects per Anthropic docs:
 *   - No `thinking_delta` text events.
 *   - The block envelope (start/stop) MAY still be present.
 *   - A final `signature_delta` (cryptographic proof of thinking) IS
 *     present. We must preserve it for clients that verify signatures.
 *
 * Frame-boundary safety:
 *   This transform must only run AFTER createIdleHeartbeatStream (which
 *   guarantees whole-frame chunk boundaries) and BEFORE any heartbeat
 *   injection that might splice between thinking-block frames. The
 *   recommended wiring is:
 *
 *     upstream.body
 *       → wrapAnthropicHeartbeat   // pings + DONE-strip + recovery
 *       → omitThinkingFromAnthropicSse  // this transform
 *
 *   wrapAnthropicHeartbeat already enforces frame-aligned downstream
 *   chunks, so this transform can decode them as text safely.
 */

const decoder = new TextDecoder("utf-8", { fatal: false })
const encoder = new TextEncoder()

interface ParsedFrame {
  event?: string
  dataRaw?: string
  full: string  // includes terminating blank line
}

/**
 * Parse an SSE chunk that is guaranteed to be aligned on whole frames
 * (the upstream heartbeat wrapper enforces this). Returns the list of
 * frames in order. A "frame" here is whatever text precedes a `\n\n`
 * or `\r\n\r\n` blank-line terminator.
 *
 * Tolerates concatenated frames in a single chunk and preserves the
 * original terminator bytes so re-serialized output is byte-identical
 * (minus the dropped frames).
 */
function parseFrames(text: string): ParsedFrame[] {
  const frames: ParsedFrame[] = []
  // Split keeping the terminators attached to the preceding frame.
  // We do this by scanning for terminators manually.
  let i = 0
  while (i < text.length) {
    // Find next terminator from i.
    let termIdx = -1
    let termLen = 0
    for (let j = i; j < text.length - 1; j++) {
      if (text[j] === "\n" && text[j + 1] === "\n") {
        termIdx = j
        termLen = 2
        break
      }
      if (
        j + 3 < text.length &&
        text[j] === "\r" &&
        text[j + 1] === "\n" &&
        text[j + 2] === "\r" &&
        text[j + 3] === "\n"
      ) {
        termIdx = j
        termLen = 4
        break
      }
    }
    if (termIdx === -1) {
      // No terminator — should not happen given frame-aligned input, but
      // include the trailing text as a frame without a terminator so we
      // don't silently drop bytes.
      frames.push({ full: text.slice(i) })
      break
    }
    const frameText = text.slice(i, termIdx + termLen)
    const inner = text.slice(i, termIdx)
    const parsed: ParsedFrame = { full: frameText }
    for (const line of inner.split(/\r?\n/)) {
      if (line.startsWith("event:")) parsed.event = line.slice(6).trim()
      else if (line.startsWith("data:")) parsed.dataRaw = (parsed.dataRaw ?? "") + line.slice(5).trimStart()
    }
    frames.push(parsed)
    i = termIdx + termLen
  }
  return frames
}

/**
 * Build the transform stream.
 *
 * State machine:
 *   - On `content_block_start` with `content_block.type === "thinking"`,
 *     remember the block index as a "thinking" block.
 *   - On `content_block_delta` for a thinking-block index:
 *       - If `delta.type === "thinking_delta"` → drop the entire frame.
 *       - If `delta.type === "signature_delta"` → preserve (signature is
 *         the proof the client needs even under omitted display).
 *       - Anything else → preserve (defensive).
 *   - On `content_block_stop` for a thinking-block index, forget it.
 *   - Any frame we don't understand → preserve unchanged.
 */
export function omitThinkingFromAnthropicSse(): TransformStream<Uint8Array, Uint8Array> {
  const thinkingBlockIndices = new Set<number>()

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const text = decoder.decode(chunk, { stream: false })
      const frames = parseFrames(text)
      const out: string[] = []

      for (const frame of frames) {
        if (!frame.event || !frame.dataRaw) {
          out.push(frame.full)
          continue
        }

        let data: unknown
        try {
          data = JSON.parse(frame.dataRaw)
        } catch {
          out.push(frame.full)
          continue
        }

        if (frame.event === "content_block_start") {
          const d = data as { index?: number; content_block?: { type?: string } }
          if (typeof d.index === "number" && d.content_block?.type === "thinking") {
            thinkingBlockIndices.add(d.index)
          }
          out.push(frame.full)
          continue
        }

        if (frame.event === "content_block_delta") {
          const d = data as { index?: number; delta?: { type?: string } }
          if (typeof d.index === "number" && thinkingBlockIndices.has(d.index)) {
            if (d.delta?.type === "thinking_delta") {
              // Drop the text delta — this is the whole point.
              continue
            }
            // signature_delta and anything else → preserve.
          }
          out.push(frame.full)
          continue
        }

        if (frame.event === "content_block_stop") {
          const d = data as { index?: number }
          if (typeof d.index === "number") {
            thinkingBlockIndices.delete(d.index)
          }
          out.push(frame.full)
          continue
        }

        out.push(frame.full)
      }

      const joined = out.join("")
      if (joined.length > 0) {
        controller.enqueue(encoder.encode(joined))
      }
    },
  })
}
