import { describe, test, expect } from 'bun:test'
import { getTranslator } from '../../src/data-plane/dispatch/translator-registry.ts'

describe('translator-registry: chat↔responses pairs', () => {
  test('chat_completions→responses translates messages → input (Responses shape)', async () => {
    const t = getTranslator('chat_completions', 'responses')
    expect(t).not.toBeNull()
    const ctx = { signal: new AbortController().signal }
    const out = (await t!.translateRequest(
      { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
      ctx,
    )) as { input?: unknown; messages?: unknown }
    expect(Array.isArray(out.input)).toBe(true)
    expect(out.messages).toBeUndefined()
  })

  test('responses→chat_completions translates input → messages (Chat shape)', async () => {
    const t = getTranslator('responses', 'chat_completions')
    expect(t).not.toBeNull()
    const ctx = { signal: new AbortController().signal }
    const out = (await t!.translateRequest(
      {
        model: 'm',
        input: [{ type: 'message', role: 'user', content: 'hi' }],
      },
      ctx,
    )) as { messages?: unknown; input?: unknown }
    expect(Array.isArray(out.messages)).toBe(true)
    expect(out.input).toBeUndefined()
  })
})
