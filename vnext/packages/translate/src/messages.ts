/**
 * Anthropic Messages ↔ IR (subset for Week 2 boot).
 * Faithful porting of cross-protocol behavior from old src/translators/messages-via-responses
 * is staged for Week 3 — this pass implements only what /v1/messages → upstream Responses →
 * /v1/messages SSE round-trip needs to satisfy the SDK accumulator alignment gate.
 */
import type {
  IRRequest,
  IREvent,
  IRMessage,
  IRContentItem,
} from '@vnext/protocols/ir'
import type { MessagesPayload } from '@vnext/protocols/messages'

export interface MessagesToIROptions {
  defaultMaxOutputTokens?: number
}

export function messagesToIR(payload: MessagesPayload, opts: MessagesToIROptions = {}): IRRequest {
  const messages: IRMessage[] = []
  if (payload.system) {
    const text = typeof payload.system === 'string'
      ? payload.system
      : payload.system
          .map((b: unknown) => (typeof b === 'object' && b && 'text' in b ? String((b as { text: string }).text) : ''))
          .join('\n')
    if (text) messages.push({ role: 'system', content: text })
  }
  for (const msg of payload.messages) {
    const content: IRContentItem[] = []
    if (typeof msg.content === 'string') {
      content.push({ type: msg.role === 'assistant' ? 'output_text' : 'input_text', text: msg.content })
    } else {
      for (const block of msg.content) {
        if (block.type === 'text') {
          content.push({ type: msg.role === 'assistant' ? 'output_text' : 'input_text', text: (block as { text: string }).text })
        } else if (block.type === 'image') {
          const src = (block as { source?: { type?: string; data?: string; media_type?: string; url?: string } }).source
          if (src?.type === 'base64' && src.data && src.media_type) {
            content.push({ type: 'input_image', image_url: `data:${src.media_type};base64,${src.data}` })
          } else if (src?.type === 'url' && src.url) {
            content.push({ type: 'input_image', image_url: src.url })
          }
        } else if (block.type === 'tool_use') {
          const b = block as { id: string; name: string; input?: unknown }
          content.push({ type: 'tool_use', id: b.id, name: b.name, arguments: b.input })
        } else if (block.type === 'tool_result') {
          const b = block as { tool_use_id: string; content?: unknown; is_error?: boolean }
          content.push({ type: 'tool_result', tool_use_id: b.tool_use_id, output: b.content, is_error: b.is_error })
        }
      }
    }
    messages.push({ role: msg.role, content })
  }
  return {
    model: payload.model,
    messages,
    tools: payload.tools?.map((t) => ({
      type: 'function',
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    })),
    max_output_tokens: payload.max_tokens ?? opts.defaultMaxOutputTokens,
    temperature: payload.temperature,
    top_p: payload.top_p,
    stream: payload.stream ?? false,
    rawClientPayload: payload,
    meta: {
      flags: {},
      binding: null,
      iteration: 0,
      privateState: {},
      clientProtocol: 'messages',
    },
  }
}

/** Anthropic Messages SSE event shapes the SDK accumulator cares about. */
export type AnthropicSSEEvent =
  | { event: 'message_start'; data: { type: 'message_start'; message: unknown } }
  | { event: 'content_block_start'; data: { type: 'content_block_start'; index: number; content_block: unknown } }
  | { event: 'content_block_delta'; data: { type: 'content_block_delta'; index: number; delta: unknown } }
  | { event: 'content_block_stop'; data: { type: 'content_block_stop'; index: number } }
  | { event: 'message_delta'; data: { type: 'message_delta'; delta: unknown; usage?: unknown } }
  | { event: 'message_stop'; data: { type: 'message_stop' } }
  | { event: 'ping'; data: { type: 'ping' } }
  | { event: 'error'; data: { type: 'error'; error: { type: string; message: string } } }

/**
 * Translate IR events back into Anthropic Messages SSE events.
 *
 * Week 2 contract: skeleton that emits text deltas + tool_use accumulation.
 * Full parity with old src/translators/messages-via-responses/transform-events.ts
 * lands in Week 3 alongside the orchestrator wiring.
 */
export function* irToMessagesSSE(events: Iterable<IREvent>): Generator<AnthropicSSEEvent> {
  let messageStarted = false
  let blockIndex = -1
  let activeBlock: { kind: 'text' } | { kind: 'tool_use'; id: string; name: string } | null = null

  function closeBlock(): AnthropicSSEEvent | null {
    if (!activeBlock) return null
    const out: AnthropicSSEEvent = {
      event: 'content_block_stop',
      data: { type: 'content_block_stop', index: blockIndex },
    }
    activeBlock = null
    return out
  }

  for (const evt of events) {
    if (evt.type === 'response.created') {
      if (!messageStarted) {
        messageStarted = true
        yield {
          event: 'message_start',
          data: {
            type: 'message_start',
            message: {
              id: evt.response.id,
              type: 'message',
              role: 'assistant',
              content: [],
              model: '',
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 0, output_tokens: 0 },
            },
          },
        }
      }
    } else if (evt.type === 'response.output_text.delta') {
      if (!activeBlock || activeBlock.kind !== 'text') {
        const closed = closeBlock(); if (closed) yield closed
        blockIndex += 1
        activeBlock = { kind: 'text' }
        yield {
          event: 'content_block_start',
          data: { type: 'content_block_start', index: blockIndex, content_block: { type: 'text', text: '' } },
        }
      }
      yield {
        event: 'content_block_delta',
        data: { type: 'content_block_delta', index: blockIndex, delta: { type: 'text_delta', text: evt.delta } },
      }
    } else if (evt.type === 'response.tool_call.completed') {
      const closed = closeBlock(); if (closed) yield closed
      blockIndex += 1
      activeBlock = { kind: 'tool_use', id: evt.itemId, name: evt.name }
      yield {
        event: 'content_block_start',
        data: {
          type: 'content_block_start',
          index: blockIndex,
          content_block: { type: 'tool_use', id: evt.itemId, name: evt.name, input: {} },
        },
      }
      yield {
        event: 'content_block_delta',
        data: {
          type: 'content_block_delta',
          index: blockIndex,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(evt.arguments ?? {}) },
        },
      }
    } else if (evt.type === 'response.completed') {
      const closed = closeBlock(); if (closed) yield closed
      yield {
        event: 'message_delta',
        data: {
          type: 'message_delta',
          delta: { stop_reason: evt.response.finish_reason ?? 'end_turn', stop_sequence: null },
          usage: evt.response.usage
            ? { input_tokens: evt.response.usage.input_tokens, output_tokens: evt.response.usage.output_tokens }
            : undefined,
        },
      }
      yield { event: 'message_stop', data: { type: 'message_stop' } }
    } else if (evt.type === 'response.error') {
      yield {
        event: 'error',
        data: { type: 'error', error: { type: evt.error.code ?? 'api_error', message: evt.error.message } },
      }
    }
  }
}
