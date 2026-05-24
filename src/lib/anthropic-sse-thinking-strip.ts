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
 * Recommended wiring:
 *   upstream.body
 *     → wrapAnthropicHeartbeat
 *     → omitThinkingFromAnthropicSse  (this transform)
 */

import { createFrameBuffer, parseDataJSON } from "./sse/parser"

const encoder = new TextEncoder()

export function omitThinkingFromAnthropicSse(): TransformStream<Uint8Array, Uint8Array> {
  const thinkingBlockIndices = new Set<number>()
  const buf = createFrameBuffer()

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const frames = buf.push(chunk)
      const out: string[] = []

      for (const frame of frames) {
        if (!frame.event || !frame.data) {
          out.push(frame.raw)
          continue
        }

        if (frame.event === "content_block_start") {
          const d = parseDataJSON<{ index?: number; content_block?: { type?: string } }>(frame)
          if (d && typeof d.index === "number" && d.content_block?.type === "thinking") {
            thinkingBlockIndices.add(d.index)
          }
          out.push(frame.raw)
          continue
        }

        if (frame.event === "content_block_delta") {
          const d = parseDataJSON<{ index?: number; delta?: { type?: string } }>(frame)
          if (d && typeof d.index === "number" && thinkingBlockIndices.has(d.index)) {
            if (d.delta?.type === "thinking_delta") {
              // Drop the text delta — this is the whole point.
              continue
            }
          }
          out.push(frame.raw)
          continue
        }

        if (frame.event === "content_block_stop") {
          const d = parseDataJSON<{ index?: number }>(frame)
          if (d && typeof d.index === "number") {
            thinkingBlockIndices.delete(d.index)
          }
          out.push(frame.raw)
          continue
        }

        out.push(frame.raw)
      }

      const joined = out.join("")
      if (joined.length > 0) {
        controller.enqueue(encoder.encode(joined))
      }
    },
    flush(controller) {
      const tail = buf.flush()
      if (tail) controller.enqueue(encoder.encode(tail.raw))
    },
  })
}
