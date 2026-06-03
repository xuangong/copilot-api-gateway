/**
 * Google Gemini generateContent ↔ IR (skeleton).
 */
import type { IRRequest, IREvent, IRMessage, IRContentItem } from '@vnext/protocols/ir'
import type { GeminiPayload } from '@vnext/protocols/gemini'

export function geminiToIR(payload: GeminiPayload, opts: { model: string }): IRRequest {
  const messages: IRMessage[] = []
  if (payload.systemInstruction) {
    const parts = 'parts' in payload.systemInstruction ? payload.systemInstruction.parts : []
    const text = parts.map((part) => {
      const pp = part as { text?: string }
      return typeof pp.text === 'string' ? pp.text : ''
    }).join('')
    if (text) messages.push({ role: 'system', content: text })
  }
  for (const c of payload.contents) {
    const role: IRMessage['role'] = c.role === 'model' ? 'assistant' : c.role === 'function' ? 'tool' : 'user'
    const items: IRContentItem[] = []
    for (const part of c.parts) {
      const p = part as {
        text?: string
        inlineData?: { mimeType: string; data: string }
        functionCall?: { name: string; args?: unknown }
        functionResponse?: { name: string; response: unknown }
      }
      if (typeof p.text === 'string') {
        items.push({ type: role === 'assistant' ? 'output_text' : 'input_text', text: p.text })
      } else if (p.inlineData) {
        items.push({ type: 'input_image', image_url: `data:${p.inlineData.mimeType};base64,${p.inlineData.data}` })
      } else if (p.functionCall) {
        items.push({ type: 'tool_use', id: p.functionCall.name, name: p.functionCall.name, arguments: p.functionCall.args })
      } else if (p.functionResponse) {
        items.push({ type: 'tool_result', tool_use_id: p.functionResponse.name, output: p.functionResponse.response })
      }
    }
    messages.push({ role, content: items })
  }
  const tools = payload.tools?.flatMap((t) =>
    (t.functionDeclarations ?? []).map((fd) => ({
      type: 'function' as const, name: fd.name, description: fd.description, parameters: fd.parameters,
    })),
  )
  const genCfg = (payload.generationConfig ?? {}) as { maxOutputTokens?: number; temperature?: number; topP?: number }
  return {
    model: opts.model,
    messages,
    tools,
    max_output_tokens: genCfg.maxOutputTokens,
    temperature: genCfg.temperature,
    top_p: genCfg.topP,
    stream: false,
    rawClientPayload: payload,
    meta: { flags: {}, binding: null, iteration: 0, privateState: {}, clientProtocol: 'gemini' },
  }
}

export type GeminiSSEChunk = {
  candidates: Array<{
    content: { role: 'model'; parts: Array<{ text?: string; functionCall?: { name: string; args: unknown } }> }
    finishReason?: string
    index: number
  }>
  usageMetadata?: { promptTokenCount: number; candidatesTokenCount: number; totalTokenCount: number }
}

export function* irToGeminiSSE(events: Iterable<IREvent>): Generator<GeminiSSEChunk> {
  for (const e of events) {
    if (e.type === 'response.output_text.delta') {
      yield { candidates: [{ index: 0, content: { role: 'model', parts: [{ text: e.delta }] } }] }
    } else if (e.type === 'response.tool_call.completed') {
      yield {
        candidates: [{
          index: 0,
          content: { role: 'model', parts: [{ functionCall: { name: e.name, args: e.arguments } }] },
        }],
      }
    } else if (e.type === 'response.completed') {
      const out: GeminiSSEChunk = {
        candidates: [{ index: 0, content: { role: 'model', parts: [] }, finishReason: mapStop(e.response.finish_reason) }],
      }
      if (e.response.usage) {
        out.usageMetadata = {
          promptTokenCount: e.response.usage.input_tokens,
          candidatesTokenCount: e.response.usage.output_tokens,
          totalTokenCount: e.response.usage.input_tokens + e.response.usage.output_tokens,
        }
      }
      yield out
    }
  }
}

function mapStop(r?: string): string {
  if (!r || r === 'stop') return 'STOP'
  if (r === 'tool_use' || r === 'tool_calls') return 'STOP'
  if (r === 'length') return 'MAX_TOKENS'
  return r.toUpperCase()
}

export function irToGeminiBody(events: Iterable<IREvent>): unknown {
  const parts: Array<{ text?: string; functionCall?: { name: string; args: unknown } }> = []
  let text = ''
  let usage = { input_tokens: 0, output_tokens: 0 }
  let stop = 'STOP'
  for (const e of events) {
    if (e.type === 'response.output_text.delta') text += e.delta
    else if (e.type === 'response.tool_call.completed') {
      parts.push({ functionCall: { name: e.name, args: e.arguments } })
    } else if (e.type === 'response.completed') {
      stop = mapStop(e.response.finish_reason)
      if (e.response.usage) usage = { input_tokens: e.response.usage.input_tokens, output_tokens: e.response.usage.output_tokens }
    }
  }
  if (text) parts.unshift({ text })
  return {
    candidates: [{ index: 0, content: { role: 'model', parts }, finishReason: stop }],
    usageMetadata: {
      promptTokenCount: usage.input_tokens,
      candidatesTokenCount: usage.output_tokens,
      totalTokenCount: usage.input_tokens + usage.output_tokens,
    },
  }
}
