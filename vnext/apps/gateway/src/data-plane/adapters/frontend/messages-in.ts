/** Frontend adapter for /v1/messages (Anthropic Messages). */
import type { FrontendAdapter } from '@vnext/translate/contract'
import { sseLine } from '@vnext/translate/contract'
import { messagesToIR, irToMessagesSSE } from '@vnext/translate/messages'
import { MessagesPayloadSchema, type MessagesPayload } from '@vnext/protocols/messages'
import type { IREvent } from '@vnext/protocols/ir'

export const messagesIn: FrontendAdapter<MessagesPayload> = {
  parse(raw) {
    const r = MessagesPayloadSchema.safeParse(raw)
    if (!r.success) {
      // Mirror old worker shape exactly: { type: 'error', error: { type: 'invalid_request_error', message } }
      const err = new Error(r.error.message)
      ;(err as Error & { status?: number; body?: unknown }).status = 400
      ;(err as Error & { body?: unknown }).body = {
        type: 'error',
        error: { type: 'invalid_request_error', message: r.error.message },
      }
      throw err
    }
    return r.data
  },
  toIR(payload) {
    return messagesToIR(payload)
  },
  encodeSSE(events) {
    const enc = new TextEncoder()
    return new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          const buffer: IREvent[] = []
          for await (const e of events) buffer.push(e)
          for (const out of irToMessagesSSE(buffer)) {
            controller.enqueue(enc.encode(sseLine(out.event, out.data)))
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          controller.enqueue(enc.encode(sseLine('error', {
            type: 'error',
            error: { type: 'api_error', message: msg },
          })))
        } finally {
          controller.close()
        }
      },
    })
  },
  async encodeBody(events) {
    const collected: IREvent[] = []
    for await (const e of events) collected.push(e)
    // collapse to single Messages response shape
    let id = ''
    const blocks: unknown[] = []
    let text = ''
    let usage: { input_tokens: number; output_tokens: number } = { input_tokens: 0, output_tokens: 0 }
    let stopReason = 'end_turn'
    for (const e of collected) {
      if (e.type === 'response.created') id = e.response.id
      else if (e.type === 'response.output_text.delta') text += e.delta
      else if (e.type === 'response.tool_call.completed') {
        blocks.push({ type: 'tool_use', id: e.itemId, name: e.name, input: e.arguments ?? {} })
      } else if (e.type === 'response.completed') {
        stopReason = e.response.finish_reason ?? 'end_turn'
        if (e.response.usage) {
          usage = { input_tokens: e.response.usage.input_tokens, output_tokens: e.response.usage.output_tokens }
        }
      }
    }
    if (text) blocks.unshift({ type: 'text', text })
    return {
      id,
      type: 'message',
      role: 'assistant',
      model: '',
      content: blocks,
      stop_reason: stopReason,
      stop_sequence: null,
      usage,
    }
  },
}
