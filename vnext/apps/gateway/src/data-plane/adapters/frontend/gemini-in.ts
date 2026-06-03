/** Frontend adapter for /v1beta/models/:model:generateContent (Gemini). */
import type { FrontendAdapter } from '@vnext/translate/contract'
import { sseLine } from '@vnext/translate/contract'
import { geminiToIR, irToGeminiSSE, irToGeminiBody } from '@vnext/translate/gemini'
import { GeminiPayloadSchema, type GeminiPayload } from '@vnext/protocols/gemini'
import type { IREvent } from '@vnext/protocols/ir'

export interface GeminiAdapter extends FrontendAdapter<GeminiPayload> {
  toIRForModel(payload: GeminiPayload, model: string): ReturnType<typeof geminiToIR>
}

export const geminiIn: GeminiAdapter = {
  parse(raw) {
    const r = GeminiPayloadSchema.safeParse(raw)
    if (!r.success) {
      const err = new Error(r.error.message)
      ;(err as Error & { status?: number; body?: unknown }).status = 400
      ;(err as Error & { body?: unknown }).body = { error: { code: 400, message: r.error.message, status: 'INVALID_ARGUMENT' } }
      throw err
    }
    return r.data
  },
  toIR(payload) {
    // Default — route handler should call toIRForModel with extracted model name.
    return geminiToIR(payload, { model: '' })
  },
  toIRForModel(payload, model) {
    return geminiToIR(payload, { model })
  },
  encodeSSE(events) {
    const enc = new TextEncoder()
    return new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          const buf: IREvent[] = []
          for await (const e of events) buf.push(e)
          for (const chunk of irToGeminiSSE(buf)) {
            controller.enqueue(enc.encode(`data: ${JSON.stringify(chunk)}\n\n`))
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          controller.enqueue(enc.encode(sseLine(null, { error: { code: 500, message: msg, status: 'INTERNAL' } })))
        } finally {
          controller.close()
        }
      },
    })
  },
  async encodeBody(events) {
    const buf: IREvent[] = []
    for await (const e of events) buf.push(e)
    return irToGeminiBody(buf)
  },
}
