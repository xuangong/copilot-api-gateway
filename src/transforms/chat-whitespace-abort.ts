/**
 * Chat-Completions SSE interceptor: abort when tool-call argument deltas
 * accumulate excessive whitespace.
 *
 * Copilot has been seen to stream pure whitespace (`\r`, `\n`, `\t`) inside
 * `delta.tool_calls[i].function.arguments` until `max_tokens` is reached,
 * never producing valid JSON. Detect that pattern and terminate the stream
 * before the client times out.
 *
 * Chat protocol has no in-band "stream error" frame. We emit a
 * `data: {"error":{...}}` chunk followed by `data: [DONE]\n\n` and close —
 * most clients surface the error field; permissive ones see only an early
 * terminator, which is still safer than a 60s hang on garbage.
 *
 * Reference: copilot-gateway chat-completions/abort-on-tool-argument-whitespace.ts
 */

import { createFrameBuffer, type SSEFrame } from "~/lib/sse/parser"

import { checkWhitespaceOverflow } from "./whitespace-guard"

const ABORT_MESSAGE =
  "Tool call arguments contained excessive consecutive whitespace, indicating a degenerate response."

interface ChatStreamChoice {
  index?: number
  delta?: {
    tool_calls?: Array<{
      index?: number
      function?: { arguments?: string }
    }>
  }
}

interface ChatStreamChunk {
  choices?: ChatStreamChoice[]
}

function isWhitespaceExceeded(
  data: string,
  whitespaceByIndex: Map<number, number>,
): boolean {
  let parsed: ChatStreamChunk
  try {
    parsed = JSON.parse(data) as ChatStreamChunk
  } catch {
    return false
  }
  const choices = parsed.choices
  if (!Array.isArray(choices)) return false
  for (const choice of choices) {
    const toolCalls = choice.delta?.tool_calls
    if (!toolCalls) continue
    for (const tc of toolCalls) {
      const args = tc.function?.arguments
      const idx = tc.index
      if (typeof args !== "string" || typeof idx !== "number") continue
      const current = whitespaceByIndex.get(idx) ?? 0
      const { count, exceeded } = checkWhitespaceOverflow(args, current)
      whitespaceByIndex.set(idx, count)
      if (exceeded) return true
    }
  }
  return false
}

function makeErrorFrame(): string {
  const payload = {
    error: {
      type: "api_error",
      message: ABORT_MESSAGE,
    },
  }
  return `data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`
}

export function createChatWhitespaceAbortStream(): TransformStream<
  Uint8Array,
  Uint8Array
> {
  const encoder = new TextEncoder()
  const frameBuffer = createFrameBuffer()
  const whitespaceByIndex = new Map<number, number>()
  let aborted = false

  const processFrame = (
    frame: SSEFrame,
    controller: TransformStreamDefaultController<Uint8Array>,
  ) => {
    if (aborted) return
    if (frame.data && frame.data !== "[DONE]") {
      if (isWhitespaceExceeded(frame.data, whitespaceByIndex)) {
        controller.enqueue(encoder.encode(makeErrorFrame()))
        aborted = true
        try { controller.terminate() } catch { /* ignore */ }
        return
      }
    }
    controller.enqueue(encoder.encode(frame.raw))
  }

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      for (const frame of frameBuffer.push(chunk)) processFrame(frame, controller)
    },
    flush(controller) {
      if (aborted) return
      const tail = frameBuffer.flush()
      if (tail) processFrame(tail, controller)
    },
  })
}
