/**
 * Fix Copilot API inconsistency: item IDs may differ between
 * response.output_item.added and response.output_item.done events.
 */
import { createFrameBuffer } from "../../shared/lib/sse/parser"

export interface StreamIdTracker {
  outputItemIds: Map<number, string>
}

export function createStreamIdTracker(): StreamIdTracker {
  return {
    outputItemIds: new Map(),
  }
}

/**
 * Fix streaming ID inconsistency for Responses API
 */
export function fixStreamIds(
  data: string,
  event: string | undefined,
  tracker: StreamIdTracker,
): string {
  if (
    event !== "response.output_item.added" &&
    event !== "response.output_item.done"
  ) {
    return data
  }

  try {
    const parsed = JSON.parse(data) as {
      output_index?: number
      item?: { id?: string }
    }
    const outputIndex = parsed.output_index
    if (typeof outputIndex !== "number" || !parsed.item?.id) return data

    if (event === "response.output_item.added") {
      tracker.outputItemIds.set(outputIndex, parsed.item.id)
      return data
    }

    const originalId = tracker.outputItemIds.get(outputIndex)
    if (originalId && parsed.item.id !== originalId) {
      parsed.item.id = originalId
      return JSON.stringify(parsed)
    }
    return data
  } catch {
    return data
  }
}

/**
 * Fix streaming chunks for Chat Completions API:
 * Remap all choice indices to 0 so split choices are treated as a single response.
 */
export function fixChatStreamLine(line: string): string {
  if (!line.startsWith("data: ") || line === "data: [DONE]") return line

  try {
    const data = JSON.parse(line.slice(6)) as {
      choices?: Array<{ index: number }>
    }
    const choices = data.choices
    if (Array.isArray(choices)) {
      for (const c of choices) {
        c.index = 0
      }
      return "data: " + JSON.stringify(data)
    }
  } catch {
    // pass through unparseable lines
  }
  return line
}

/**
 * Create a transform stream that fixes Chat Completions streaming
 */
export function createChatStreamFixer(): TransformStream<
  Uint8Array,
  Uint8Array
> {
  const encoder = new TextEncoder()
  const frameBuffer = createFrameBuffer()

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      for (const frame of frameBuffer.push(chunk)) {
        controller.enqueue(encoder.encode(fixChatFrame(frame)))
      }
    },
    flush(controller) {
      const tail = frameBuffer.flush()
      if (tail) {
        controller.enqueue(encoder.encode(fixChatFrame(tail)))
      }
    },
  })
}

function fixChatFrame(frame: { raw: string; data?: string }): string {
  if (!frame.data || frame.data === "[DONE]") return frame.raw
  try {
    const data = JSON.parse(frame.data) as {
      choices?: Array<{ index: number }>
    }
    const choices = data.choices
    if (Array.isArray(choices)) {
      for (const c of choices) {
        c.index = 0
      }
      // Re-serialize preserving terminator from raw
      const tail = frame.raw.endsWith("\r\n\r\n") ? "\r\n\r\n"
        : frame.raw.endsWith("\n\n") ? "\n\n" : "\n"
      return "data: " + JSON.stringify(data) + tail
    }
  } catch { /* pass through */ }
  return frame.raw
}
