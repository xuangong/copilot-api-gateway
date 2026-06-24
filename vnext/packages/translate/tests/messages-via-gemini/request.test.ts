import { describe, it, expect } from 'bun:test'
import { translateMessagesToGemini } from '@vnext-llm/translate/messages-via-gemini'

describe('messages-via-gemini :: request', () => {
  it('translates a minimal Messages payload into Gemini contents', () => {
    const out = translateMessagesToGemini({
      model: 'gemini-1.5-pro',
      max_tokens: 256,
      messages: [{ role: 'user', content: 'hello' }],
    } as never)

    expect(Array.isArray(out.contents)).toBe(true)
    expect(out.contents).toHaveLength(1)
    expect(out.contents[0]?.role).toBe('user')
    const parts = out.contents[0]?.parts ?? []
    const textPart = parts.find((p) => 'text' in (p as object)) as { text: string } | undefined
    expect(textPart?.text).toBe('hello')
  })

  it('hoists Anthropic system into systemInstruction.parts', () => {
    const out = translateMessagesToGemini({
      model: 'g',
      max_tokens: 64,
      system: 'be brief',
      messages: [{ role: 'user', content: 'hi' }],
    } as never)
    const sys = out.systemInstruction as { parts: Array<{ text: string }> } | undefined
    expect(sys?.parts?.[0]?.text).toBe('be brief')
  })

  it('maps assistant tool_use into a model functionCall part', () => {
    const out = translateMessagesToGemini({
      model: 'g',
      max_tokens: 64,
      messages: [
        { role: 'user', content: 'q' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'looking up' },
            { type: 'tool_use', id: 'tu_1', name: 'lookup', input: { q: 'k' } },
          ],
        },
      ],
    } as never)

    const modelTurn = out.contents.find((c) => c.role === 'model')
    expect(modelTurn).toBeDefined()
    const parts = modelTurn?.parts ?? []
    const fnPart = parts.find((p) => 'functionCall' in (p as object)) as
      | { functionCall: { name: string; args: Record<string, unknown> } }
      | undefined
    expect(fnPart?.functionCall?.name).toBe('lookup')
    expect(fnPart?.functionCall?.args).toEqual({ q: 'k' })
  })

  it('maps user tool_result into a function role with functionResponse', () => {
    const out = translateMessagesToGemini({
      model: 'g',
      max_tokens: 64,
      messages: [
        { role: 'user', content: 'q' },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tu_1', name: 'lookup', input: { q: 'k' } }],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: '{"v":1}' }],
        },
      ],
    } as never)

    const fnTurn = out.contents.find((c) => c.role === 'function')
    expect(fnTurn).toBeDefined()
    const parts = fnTurn?.parts ?? []
    const fr = parts.find((p) => 'functionResponse' in (p as object)) as
      | { functionResponse: { name: string; response: unknown } }
      | undefined
    expect(fr).toBeDefined()
    // tool_use_id maps to functionResponse.name (mirrors gemini-via-messages inverse)
    expect(fr?.functionResponse?.name).toBe('lookup')
  })

  it('translates Anthropic tools[] into functionDeclarations', () => {
    const out = translateMessagesToGemini({
      model: 'g',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'q' }],
      tools: [
        {
          name: 'lookup',
          description: 'lookup a thing',
          input_schema: { type: 'object', properties: { q: { type: 'string' } } },
        },
      ],
    } as never)

    const groups = out.tools as Array<{ functionDeclarations?: Array<{ name: string; description?: string; parameters?: unknown }> }> | undefined
    expect(groups).toBeDefined()
    expect(groups?.[0]?.functionDeclarations?.[0]?.name).toBe('lookup')
    expect(groups?.[0]?.functionDeclarations?.[0]?.description).toBe('lookup a thing')
    expect(groups?.[0]?.functionDeclarations?.[0]?.parameters).toMatchObject({ type: 'object' })
  })

  it('forwards generation knobs onto generationConfig', () => {
    const out = translateMessagesToGemini({
      model: 'g',
      max_tokens: 1024,
      temperature: 0.5,
      top_p: 0.9,
      stop_sequences: ['STOP'],
      messages: [{ role: 'user', content: 'hi' }],
    } as never)
    const gc = out.generationConfig as {
      maxOutputTokens?: number
      temperature?: number
      topP?: number
      stopSequences?: string[]
    } | undefined
    expect(gc?.maxOutputTokens).toBe(1024)
    expect(gc?.temperature).toBe(0.5)
    expect(gc?.topP).toBe(0.9)
    expect(gc?.stopSequences).toEqual(['STOP'])
  })

  it('maps thinking.budget_tokens into generationConfig.thinkingConfig', () => {
    const out = translateMessagesToGemini({
      model: 'g',
      max_tokens: 1024,
      thinking: { type: 'enabled', budget_tokens: 4096 },
      messages: [{ role: 'user', content: 'hi' }],
    } as never)
    const gc = out.generationConfig as { thinkingConfig?: { thinkingBudget?: number } } | undefined
    expect(gc?.thinkingConfig?.thinkingBudget).toBe(4096)
  })

  it('maps tool_choice.any to toolConfig functionCallingConfig.mode=ANY', () => {
    const out = translateMessagesToGemini({
      model: 'g',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'q' }],
      tools: [{ name: 'lookup', input_schema: { type: 'object' } }],
      tool_choice: { type: 'any' },
    } as never)
    const tc = out.toolConfig as { functionCallingConfig?: { mode?: string } } | undefined
    expect(tc?.functionCallingConfig?.mode).toBe('ANY')
  })
})
