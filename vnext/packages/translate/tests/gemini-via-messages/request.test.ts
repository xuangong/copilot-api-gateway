import { describe, it, expect } from 'bun:test'
import { translateGeminiToMessages } from '@vnext-llm/translate/gemini-via-messages'

describe('gemini-via-messages :: request', () => {
  it('translates a minimal Gemini contents to a Messages payload', () => {
    const out = translateGeminiToMessages(
      {
        contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
      } as never,
      { model: 'claude-3-5-sonnet' },
    )
    expect(out.model).toBe('claude-3-5-sonnet')
    expect(out.messages).toHaveLength(1)
    expect(out.messages[0]?.role).toBe('user')
    const blocks = out.messages[0]?.content as Array<{ type: string; text?: string }>
    expect(Array.isArray(blocks)).toBe(true)
    expect(blocks[0]?.type).toBe('text')
    expect(blocks[0]?.text).toBe('hello')
  })

  it('promotes systemInstruction.parts[].text into Messages system block', () => {
    const out = translateGeminiToMessages(
      {
        systemInstruction: { parts: [{ text: 'be brief' }, { text: ' and kind' }] },
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      } as never,
      { model: 'm' },
    )
    const sys = out.system as Array<{ type: string; text: string }>
    expect(Array.isArray(sys)).toBe(true)
    expect(sys[0]?.type).toBe('text')
    expect(sys[0]?.text).toBe('be brief and kind')
  })

  it('maps role: model → assistant and inlineData → image base64', () => {
    const out = translateGeminiToMessages(
      {
        contents: [
          { role: 'user', parts: [
            { text: 'see this:' },
            { inlineData: { mimeType: 'image/png', data: 'AAA' } },
          ] },
          { role: 'model', parts: [{ text: 'looks good' }] },
        ],
      } as never,
      { model: 'm' },
    )
    expect(out.messages).toHaveLength(2)
    expect(out.messages[0]?.role).toBe('user')
    expect(out.messages[1]?.role).toBe('assistant')
    const userBlocks = out.messages[0]?.content as Array<{ type: string; text?: string; source?: { type: string; media_type?: string; data?: string } }>
    expect(userBlocks.some((b) => b.type === 'image' && b.source?.type === 'base64' && b.source?.data === 'AAA')).toBe(true)
  })

  it('translates functionDeclarations[] into Messages tools[]', () => {
    const out = translateGeminiToMessages(
      {
        contents: [{ role: 'user', parts: [{ text: 'q' }] }],
        tools: [
          {
            functionDeclarations: [
              { name: 'lookup', description: 'lookup something', parameters: { type: 'object', properties: { q: { type: 'string' } } } },
            ],
          },
        ],
      } as never,
      { model: 'm' },
    )
    const tools = out.tools as Array<{ name: string; description?: string; input_schema?: unknown }> | undefined
    expect(tools).toBeDefined()
    expect(tools).toHaveLength(1)
    expect(tools?.[0]?.name).toBe('lookup')
    expect(tools?.[0]?.description).toBe('lookup something')
    expect(tools?.[0]?.input_schema).toMatchObject({ type: 'object' })
  })

  it('forwards generationConfig knobs (max/temperature/topP)', () => {
    const out = translateGeminiToMessages(
      {
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        generationConfig: { maxOutputTokens: 512, temperature: 0.7, topP: 0.9 },
      } as never,
      { model: 'm' },
    )
    expect(out.max_tokens).toBe(512)
    expect(out.temperature).toBe(0.7)
    expect(out.top_p).toBe(0.9)
  })

  it('falls back to options.fallbackMaxOutputTokens when generationConfig.maxOutputTokens missing', () => {
    const out = translateGeminiToMessages(
      { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] } as never,
      { model: 'm', fallbackMaxOutputTokens: 1234 },
    )
    expect(out.max_tokens).toBe(1234)
  })

  it('routes function role/functionResponse into a tool_result block', () => {
    const out = translateGeminiToMessages(
      {
        contents: [
          { role: 'user', parts: [{ text: 'q' }] },
          { role: 'model', parts: [{ functionCall: { name: 'lookup', args: { q: 'k' } } }] },
          { role: 'function', parts: [{ functionResponse: { name: 'lookup', response: { v: 1 } } }] },
        ],
      } as never,
      { model: 'm' },
    )
    // Flow: 1 user, 1 assistant (tool_use), 1 user (tool_result wrapper)
    expect(out.messages.length).toBeGreaterThanOrEqual(3)
    const last = out.messages[out.messages.length - 1]!
    expect(last.role).toBe('user')
    const blocks = last.content as Array<{ type: string; tool_use_id?: string; content?: unknown }>
    expect(blocks.find((b) => b.type === 'tool_result')?.tool_use_id).toBe('lookup')
  })

  it('maps thinkingConfig.thinkingBudget to thinking block (effort buckets)', () => {
    const lowOut = translateGeminiToMessages(
      {
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        generationConfig: { thinkingConfig: { thinkingBudget: 1024 } },
      } as never,
      { model: 'm' },
    )
    expect((lowOut.thinking as { type: string; budget_tokens: number } | undefined)?.type).toBe('enabled')
    const highOut = translateGeminiToMessages(
      {
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        generationConfig: { thinkingConfig: { thinkingBudget: 16384 } },
      } as never,
      { model: 'm' },
    )
    expect((highOut.thinking as { type: string; budget_tokens: number } | undefined)?.budget_tokens).toBeGreaterThanOrEqual(8192)
  })
})
