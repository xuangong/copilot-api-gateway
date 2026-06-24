// vnext/packages/gateway/src/data-plane/chat-flow/messages/events/reassemble.ts
/**
 * Reassemble a Messages SSE event stream into the JSON `MessagesResult`
 * envelope that non-streaming clients expect. Mirrors the legacy
 * `MessageStream.test.ts` accumulator — `message_start` carries the initial
 * usage and model, `content_block_*` events build up the content array,
 * `message_delta` carries final stop_reason + delta usage, `message_stop`
 * is the terminator.
 *
 * The output shape matches `MessagesResult` from `@vnext-llm/protocols/messages`.
 * Used by `respond.ts` in the non-streaming branch so the synthesised frame
 * sequence we generate from the upstream JSON body can drain through the
 * same `consumeWithState` + `withUpstreamTelemetry` plumbing as the SSE
 * branch and still emit a JSON envelope to the client.
 */
import type {
  MessagesResult,
  MessagesStreamEvent,
  MessagesUsage,
} from '@vnext-llm/protocols/messages'
import type { ProtocolFrame } from '@vnext-llm/protocols/common'

interface PartialBlock {
  type: string
  text?: string
  // tool_use / server_tool_use accumulator state — kept as a partial JSON
  // string until the upstream JSON delta finalises.
  inputJson?: string
  // Pass-through for fields that arrive on content_block_start.
  start?: Record<string, unknown>
}

const blockToOutput = (block: PartialBlock): Record<string, unknown> => {
  if (block.type === 'text') {
    return { type: 'text', text: block.text ?? '' }
  }
  if (block.type === 'tool_use' || block.type === 'server_tool_use') {
    let input: Record<string, unknown> = {}
    if (block.inputJson) {
      try {
        input = JSON.parse(block.inputJson) as Record<string, unknown>
      } catch {
        input = {}
      }
    }
    return { ...(block.start ?? {}), input }
  }
  return { ...(block.start ?? {}), type: block.type }
}

export const collectMessagesProtocolEventsToResult = async (
  frames: AsyncIterable<ProtocolFrame<MessagesStreamEvent>>,
): Promise<MessagesResult> => {
  let id = ''
  let model = ''
  let stop_reason: MessagesResult['stop_reason'] = null
  let stop_sequence: string | null = null
  const usage: MessagesUsage = { input_tokens: 0, output_tokens: 0 }
  const blocks: PartialBlock[] = []
  let saw_stop = false

  for await (const frame of frames) {
    if (frame.type !== 'event') continue
    const ev = frame.event
    if (ev.type === 'message_start') {
      id = ev.message.id
      model = ev.message.model
      const u = ev.message.usage
      usage.input_tokens = u.input_tokens ?? 0
      usage.output_tokens = u.output_tokens ?? 0
      if (typeof u.cache_creation_input_tokens === 'number') {
        usage.cache_creation_input_tokens = u.cache_creation_input_tokens
      }
      if (typeof u.cache_read_input_tokens === 'number') {
        usage.cache_read_input_tokens = u.cache_read_input_tokens
      }
    } else if (ev.type === 'content_block_start') {
      const cb = ev.content_block as { type?: string; text?: string } & Record<string, unknown>
      blocks[ev.index] = {
        type: cb.type ?? 'text',
        text: cb.type === 'text' ? (cb.text ?? '') : undefined,
        inputJson: cb.type === 'tool_use' || cb.type === 'server_tool_use' ? '' : undefined,
        start: cb,
      }
    } else if (ev.type === 'content_block_delta') {
      const block = blocks[ev.index]
      if (!block) continue
      const d = ev.delta as { type?: string; text?: string; partial_json?: string }
      if (d.type === 'text_delta' && typeof d.text === 'string') {
        block.text = (block.text ?? '') + d.text
      } else if (d.type === 'input_json_delta' && typeof d.partial_json === 'string') {
        block.inputJson = (block.inputJson ?? '') + d.partial_json
      }
    } else if (ev.type === 'message_delta') {
      if (ev.delta.stop_reason !== undefined) stop_reason = ev.delta.stop_reason
      if (ev.delta.stop_sequence !== undefined) stop_sequence = ev.delta.stop_sequence ?? null
      if (ev.usage && typeof ev.usage.output_tokens === 'number') {
        usage.output_tokens = ev.usage.output_tokens
      }
    } else if (ev.type === 'message_stop') {
      saw_stop = true
    } else if (ev.type === 'error') {
      throw new Error(`messages stream errored: ${ev.error.message}`)
    }
  }

  if (!saw_stop) {
    throw new Error('messages stream ended without message_stop terminal frame')
  }

  return {
    id,
    type: 'message',
    role: 'assistant',
    model,
    content: blocks.filter((b): b is PartialBlock => b !== undefined).map(blockToOutput) as unknown as MessagesResult['content'],
    stop_reason,
    stop_sequence,
    usage,
  }
}
