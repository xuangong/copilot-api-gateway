/** Frontend adapter for /v1/responses (OpenAI Responses). */
import type { FrontendAdapter } from '@vnext/translate/contract'
import { sseLine } from '@vnext/translate/contract'
import { responsesToIR, irToResponsesSSE, irToResponsesBody } from '@vnext/translate/responses'
import { ResponsesPayloadSchema, type ResponsesPayload } from '@vnext/protocols/responses'
import type { IREvent } from '@vnext/protocols/ir'

export const responsesIn: FrontendAdapter<ResponsesPayload> = {
  parse(raw) {
    const r = ResponsesPayloadSchema.safeParse(raw)
    if (!r.success) {
      const err = new Error(r.error.message)
      ;(err as Error & { status?: number; body?: unknown }).status = 400
      ;(err as Error & { body?: unknown }).body = { error: { message: r.error.message, type: 'invalid_request_error' } }
      throw err
    }
    return r.data
  },
  toIR(payload) {
    return responsesToIR(payload)
  },
  encodeSSE(events) {
    const enc = new TextEncoder()
    return new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          const buf: IREvent[] = []
          for await (const e of events) buf.push(e)
          for (const out of irToResponsesSSE(buf)) {
            controller.enqueue(enc.encode(sseLine(out.event, out.data)))
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          controller.enqueue(enc.encode(sseLine('error', { type: 'error', error: { message: msg, type: 'api_error' } })))
        } finally {
          controller.close()
        }
      },
    })
  },
  async encodeBody(events) {
    const buf: IREvent[] = []
    for await (const e of events) buf.push(e)
    return irToResponsesBody(buf)
  },
}
