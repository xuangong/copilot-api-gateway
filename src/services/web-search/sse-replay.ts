import type { ApiResponse, MessageContent } from "./types"

/**
 * Replay a non-streaming Anthropic Messages API response as a standard
 * Anthropic SSE event stream. Used by the web_search streaming path:
 * we run the full multi-turn intercept loop synchronously, then play
 * the final assistant response back to the client as if it had streamed.
 *
 * Emitted events follow Anthropic's documented streaming protocol:
 *   message_start
 *   content_block_start (per block)
 *   content_block_delta  (per block — text is chunked into many)
 *   content_block_stop  (per block)
 *   message_delta       (with stop_reason + usage)
 *   message_stop
 */
export interface ReplayOptions {
  /** Skip emitting `message_start` (caller already sent a synthetic one). */
  skipMessageStart?: boolean
}

/** Delay between text deltas (ms). Forces each delta into its own network
 * flush so the dashboard / SDK clients render progressively instead of
 * receiving one big TCP segment. */
const DELTA_INTERVAL_MS = 12
/** Codepoint count per delta. CJK-safe. */
const DELTA_CHUNK_SIZE = 24

export function replayResponseAsSSE(
  response: ApiResponse,
  opts: ReplayOptions = {},
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()

  function frame(eventName: string, data: unknown): Uint8Array {
    return encoder.encode(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  // Pre-build the ordered list of frames as plain objects so the pull-loop
  // can interleave delays only between text deltas (other frames flush
  // back-to-back).
  type Frame = { bytes: Uint8Array; pacing: boolean }
  const frames: Array<Frame> = []

  if (!opts.skipMessageStart) {
    frames.push({
      bytes: frame("message_start", {
        type: "message_start",
        message: {
          id: response.id,
          type: response.type ?? "message",
          role: response.role ?? "assistant",
          model: response.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: response.usage ?? { input_tokens: 0, output_tokens: 0 },
        },
      }),
      pacing: false,
    })
  }

  const blocks = Array.isArray(response.content) ? response.content : []
  blocks.forEach((block, index) => {
    appendBlock(frames, frame, block, index)
  })

  frames.push({
    bytes: frame("message_delta", {
      type: "message_delta",
      delta: {
        stop_reason: response.stop_reason ?? "end_turn",
        stop_sequence: null,
      },
      usage: response.usage ?? { input_tokens: 0, output_tokens: 0 },
    }),
    pacing: false,
  })
  frames.push({ bytes: frame("message_stop", { type: "message_stop" }), pacing: false })

  let i = 0
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (i >= frames.length) {
        controller.close()
        return
      }
      const f = frames[i++]!
      controller.enqueue(f.bytes)
      if (f.pacing && i < frames.length) {
        await new Promise<void>((r) => setTimeout(r, DELTA_INTERVAL_MS))
      }
    },
  })
}

function appendBlock(
  out: Array<{ bytes: Uint8Array; pacing: boolean }>,
  frame: (eventName: string, data: unknown) => Uint8Array,
  block: MessageContent,
  index: number,
): void {
  if (block.type === "text") {
    out.push({
      bytes: frame("content_block_start", {
        type: "content_block_start",
        index,
        content_block: { type: "text", text: "" },
      }),
      pacing: false,
    })
    for (const piece of chunkText(block.text ?? "")) {
      out.push({
        bytes: frame("content_block_delta", {
          type: "content_block_delta",
          index,
          delta: { type: "text_delta", text: piece },
        }),
        pacing: true,
      })
    }
    out.push({
      bytes: frame("content_block_stop", { type: "content_block_stop", index }),
      pacing: false,
    })
    return
  }

  if (block.type === "tool_use") {
    out.push({
      bytes: frame("content_block_start", {
        type: "content_block_start",
        index,
        content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
      }),
      pacing: false,
    })
    out.push({
      bytes: frame("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: {
          type: "input_json_delta",
          partial_json: JSON.stringify(block.input ?? {}),
        },
      }),
      pacing: false,
    })
    out.push({
      bytes: frame("content_block_stop", { type: "content_block_stop", index }),
      pacing: false,
    })
    return
  }

  if (block.type === "thinking") {
    out.push({
      bytes: frame("content_block_start", {
        type: "content_block_start",
        index,
        content_block: { type: "thinking", thinking: "" },
      }),
      pacing: false,
    })
    out.push({
      bytes: frame("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "thinking_delta", thinking: block.thinking ?? "" },
      }),
      pacing: false,
    })
    out.push({
      bytes: frame("content_block_stop", { type: "content_block_stop", index }),
      pacing: false,
    })
    return
  }

  out.push({
    bytes: frame("content_block_start", {
      type: "content_block_start",
      index,
      content_block: { type: "text", text: "" },
    }),
    pacing: false,
  })
  out.push({
    bytes: frame("content_block_delta", {
      type: "content_block_delta",
      index,
      delta: { type: "text_delta", text: JSON.stringify(block) },
    }),
    pacing: false,
  })
  out.push({
    bytes: frame("content_block_stop", { type: "content_block_stop", index }),
    pacing: false,
  })
}

function chunkText(text: string, size = DELTA_CHUNK_SIZE): Array<string> {
  if (!text) return [""]
  const chars = Array.from(text)
  if (chars.length <= size) return [text]
  const out: Array<string> = []
  for (let i = 0; i < chars.length; i += size) {
    out.push(chars.slice(i, i + size).join(""))
  }
  return out
}
