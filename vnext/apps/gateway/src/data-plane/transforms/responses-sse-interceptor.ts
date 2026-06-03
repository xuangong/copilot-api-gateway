/**
 * Responses-SSE interceptors composed into one TransformStream.
 *
 * Two behaviors wrapped around the upstream byte stream after the heartbeat
 * wrapper has already guaranteed whole-frame boundaries:
 *
 *   1. Synchronize `output_item.added` / `output_item.done` IDs per
 *      `output_index` — Copilot occasionally emits a different ID on `done`
 *      than it sent on `added`. Downstream clients treat them as two items
 *      otherwise. See `streaming-id-fix.ts`.
 *
 *   2. Abort the stream when `response.function_call_arguments.delta` events
 *      accumulate more than MAX_CONSECUTIVE_WHITESPACE characters for a
 *      single output index — degenerate Copilot output. Emit a synthetic
 *      Responses `error` event then close. See `whitespace-guard.ts`.
 *
 * Lives at the Copilot Responses provider boundary so other providers do not
 * pay the per-frame cost.
 *
 * References:
 *   - copilot-gateway responses/synchronize-output-item-ids.ts
 *   - copilot-gateway responses/abort-on-tool-argument-whitespace.ts
 */

import { parseFrames, type SSEFrame } from "../../shared/lib/sse/parser"
import { checkWhitespaceOverflow } from "./whitespace-guard"

const ABORT_MESSAGE =
  "Tool call arguments contained excessive whitespace, indicating a degenerate response."

interface ItemAddedDoneData {
  output_index?: number
  item?: { id?: string }
}

interface ArgumentsDeltaData {
  output_index?: number
  delta?: string
}

function fixItemIdFrame(
  frame: SSEFrame,
  outputItemIds: Map<number, string>,
): string {
  if (
    (frame.event !== "response.output_item.added"
      && frame.event !== "response.output_item.done")
    || !frame.data
  ) {
    return frame.raw
  }
  let data: ItemAddedDoneData
  try {
    data = JSON.parse(frame.data) as ItemAddedDoneData
  } catch {
    return frame.raw
  }
  const idx = data.output_index
  const id = data.item?.id
  if (typeof idx !== "number" || typeof id !== "string") return frame.raw

  if (frame.event === "response.output_item.added") {
    outputItemIds.set(idx, id)
    return frame.raw
  }
  const original = outputItemIds.get(idx)
  if (!original || id === original) return frame.raw
  data.item!.id = original
  const term = pickTerminator(frame.raw)
  return `event: ${frame.event}\ndata: ${JSON.stringify(data)}${term}`
}

function pickTerminator(raw: string): string {
  if (raw.endsWith("\r\n\r\n")) return "\r\n\r\n"
  return "\n\n"
}

function makeErrorFrame(): string {
  const payload = { type: "error", message: ABORT_MESSAGE, code: "api_error" }
  return `event: error\ndata: ${JSON.stringify(payload)}\n\n`
}

/**
 * Returns true (and sets `count`) if the frame is a function_call_arguments
 * delta that pushed any output index over the whitespace threshold.
 */
function checkWhitespaceFrame(
  frame: SSEFrame,
  whitespaceByIndex: Map<number, number>,
): boolean {
  if (
    frame.event !== "response.function_call_arguments.delta"
    || !frame.data
  ) {
    return false
  }
  let data: ArgumentsDeltaData
  try {
    data = JSON.parse(frame.data) as ArgumentsDeltaData
  } catch {
    return false
  }
  const idx = data.output_index
  const delta = data.delta
  if (typeof idx !== "number" || typeof delta !== "string") return false
  const current = whitespaceByIndex.get(idx) ?? 0
  const { count, exceeded } = checkWhitespaceOverflow(delta, current)
  whitespaceByIndex.set(idx, count)
  return exceeded
}

/**
 * Build a TransformStream that applies both Responses-SSE interceptors.
 *
 * The upstream byte stream must already be at frame boundaries (i.e. wrapped
 * by `wrapOpenAIHeartbeat` or another whole-frame producer). We parse each
 * incoming chunk into one or more complete frames, mutate or filter them,
 * and re-emit byte-for-byte except where we rewrote the data.
 */
export function createResponsesInterceptorStream(): TransformStream<
  Uint8Array,
  Uint8Array
> {
  const encoder = new TextEncoder()
  const decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false })
  const outputItemIds = new Map<number, string>()
  const whitespaceByIndex = new Map<number, number>()
  let buffer = ""
  let aborted = false

  const processChunk = (
    text: string,
    controller: TransformStreamDefaultController<Uint8Array>,
  ) => {
    if (aborted) return
    buffer += text
    // Find last complete frame terminator to bound parseFrames input.
    let lastTerm = -1
    let lastTermLen = 0
    for (let j = 0; j < buffer.length - 1; j++) {
      if (buffer[j] === "\n" && buffer[j + 1] === "\n") {
        lastTerm = j
        lastTermLen = 2
      } else if (
        j + 3 < buffer.length
        && buffer[j] === "\r" && buffer[j + 1] === "\n"
        && buffer[j + 2] === "\r" && buffer[j + 3] === "\n"
      ) {
        lastTerm = j
        lastTermLen = 4
      }
    }
    if (lastTerm === -1) return
    const whole = buffer.slice(0, lastTerm + lastTermLen)
    buffer = buffer.slice(lastTerm + lastTermLen)
    for (const frame of parseFrames(whole)) {
      if (checkWhitespaceFrame(frame, whitespaceByIndex)) {
        controller.enqueue(encoder.encode(makeErrorFrame()))
        aborted = true
        try { controller.terminate() } catch { /* ignore */ }
        return
      }
      const out = fixItemIdFrame(frame, outputItemIds)
      controller.enqueue(encoder.encode(out))
    }
  }

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      processChunk(decoder.decode(chunk, { stream: true }), controller)
    },
    flush(controller) {
      if (aborted) return
      const tail = decoder.decode()
      if (tail) buffer += tail
      if (buffer.length > 0) controller.enqueue(encoder.encode(buffer))
      buffer = ""
    },
  })
}
