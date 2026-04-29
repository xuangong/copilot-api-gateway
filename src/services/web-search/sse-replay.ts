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
 *   content_block_delta  (per block, single delta)
 *   content_block_stop  (per block)
 *   message_delta       (with stop_reason + usage)
 *   message_stop
 */
export function replayResponseAsSSE(response: ApiResponse): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()

  function frame(eventName: string, data: unknown): Uint8Array {
    return encoder.encode(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  return new ReadableStream<Uint8Array>({
    start(controller) {
      // 1. message_start with empty content
      controller.enqueue(
        frame("message_start", {
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
      )

      // 2. for each content block: start, single delta, stop
      const blocks = Array.isArray(response.content) ? response.content : []
      blocks.forEach((block, index) => emitBlock(controller, frame, block, index))

      // 3. message_delta with stop_reason + usage
      controller.enqueue(
        frame("message_delta", {
          type: "message_delta",
          delta: {
            stop_reason: response.stop_reason ?? "end_turn",
            stop_sequence: null,
          },
          usage: response.usage ?? { input_tokens: 0, output_tokens: 0 },
        }),
      )

      // 4. message_stop
      controller.enqueue(frame("message_stop", { type: "message_stop" }))
      controller.close()
    },
  })
}

function emitBlock(
  controller: ReadableStreamDefaultController<Uint8Array>,
  frame: (eventName: string, data: unknown) => Uint8Array,
  block: MessageContent,
  index: number,
): void {
  if (block.type === "text") {
    controller.enqueue(
      frame("content_block_start", {
        type: "content_block_start",
        index,
        content_block: { type: "text", text: "" },
      }),
    )
    controller.enqueue(
      frame("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "text_delta", text: block.text ?? "" },
      }),
    )
    controller.enqueue(
      frame("content_block_stop", { type: "content_block_stop", index }),
    )
    return
  }

  if (block.type === "tool_use") {
    controller.enqueue(
      frame("content_block_start", {
        type: "content_block_start",
        index,
        content_block: {
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: {},
        },
      }),
    )
    controller.enqueue(
      frame("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: {
          type: "input_json_delta",
          partial_json: JSON.stringify(block.input ?? {}),
        },
      }),
    )
    controller.enqueue(
      frame("content_block_stop", { type: "content_block_stop", index }),
    )
    return
  }

  if (block.type === "thinking") {
    controller.enqueue(
      frame("content_block_start", {
        type: "content_block_start",
        index,
        content_block: { type: "thinking", thinking: "" },
      }),
    )
    controller.enqueue(
      frame("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "thinking_delta", thinking: block.thinking ?? "" },
      }),
    )
    controller.enqueue(
      frame("content_block_stop", { type: "content_block_stop", index }),
    )
    return
  }

  // Fallback: emit as text block with stringified content
  controller.enqueue(
    frame("content_block_start", {
      type: "content_block_start",
      index,
      content_block: { type: "text", text: "" },
    }),
  )
  controller.enqueue(
    frame("content_block_delta", {
      type: "content_block_delta",
      index,
      delta: { type: "text_delta", text: JSON.stringify(block) },
    }),
  )
  controller.enqueue(
    frame("content_block_stop", { type: "content_block_stop", index }),
  )
}
