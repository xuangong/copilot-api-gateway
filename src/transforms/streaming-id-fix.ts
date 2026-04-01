/**
 * Fix Copilot API inconsistency: item IDs may differ between
 * response.output_item.added and response.output_item.done events.
 */
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
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ""

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true })
      const lines = buffer.split("\n")
      buffer = lines.pop()! // keep incomplete last line

      for (const line of lines) {
        controller.enqueue(encoder.encode(fixChatStreamLine(line) + "\n"))
      }
    },
    flush(controller) {
      if (buffer) {
        controller.enqueue(encoder.encode(fixChatStreamLine(buffer) + "\n"))
      }
    },
  })
}
