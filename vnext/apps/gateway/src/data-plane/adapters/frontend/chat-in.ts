/** Frontend adapter for /v1/chat/completions (OpenAI Chat). */
import type { FrontendAdapter } from '@vnext/translate/contract'
import { sseLine } from '@vnext/translate/contract'
import { chatToIR, irToChatSSE, irToChatBody } from '@vnext/translate/chat'
import { ChatPayloadSchema, type ChatPayload } from '@vnext/protocols/chat'
import type { IREvent } from '@vnext/protocols/ir'

export const chatIn: FrontendAdapter<ChatPayload> = {
  parse(raw) {
    const r = ChatPayloadSchema.safeParse(raw)
    if (!r.success) {
      const err = new Error(r.error.message)
      ;(err as Error & { status?: number; body?: unknown }).status = 400
      ;(err as Error & { body?: unknown }).body = { error: { message: r.error.message, type: 'invalid_request_error' } }
      throw err
    }
    return r.data
  },
  toIR(payload) {
    return chatToIR(payload)
  },
  encodeSSE(events) {
    const enc = new TextEncoder()
    return new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          const buf: IREvent[] = []
          for await (const e of events) buf.push(e)
          for (const chunk of irToChatSSE(buf)) {
            controller.enqueue(enc.encode(sseLine(null, chunk)))
          }
          controller.enqueue(enc.encode('data: [DONE]\n\n'))
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          controller.enqueue(enc.encode(sseLine(null, { error: { message: msg, type: 'api_error' } })))
        } finally {
          controller.close()
        }
      },
    })
  },
  async encodeBody(events) {
    const buf: IREvent[] = []
    for await (const e of events) buf.push(e)
    return irToChatBody(buf)
  },
}
