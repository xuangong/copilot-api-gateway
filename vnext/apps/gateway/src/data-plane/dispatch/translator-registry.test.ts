/**
 * translator-registry tests — exercises the source→target table that the
 * dispatch pipeline uses to pick a PairTranslator per route.
 *
 * Cases cover:
 *  1. messages→messages returns the identity translator (zero-cost fast path)
 *  2. chat→messages returns the chat-completions-via-messages translator
 *  3. messages→chat_completions returns the inverse translator
 *  4. unknown pair (e.g. messages→embeddings) returns null
 *  5. PairTranslator behavior: identity translateRequest/translateEvents passes through
 */
import { test, expect, describe } from 'bun:test'
import { getTranslator, IDENTITY_TRANSLATOR } from './translator-registry.ts'

describe('getTranslator', () => {
  test('messages→messages returns the identity translator', () => {
    const t = getTranslator('messages', 'messages')
    expect(t).toBe(IDENTITY_TRANSLATOR)
  })

  test('chat_completions→messages returns a translator with the three required methods', () => {
    const t = getTranslator('chat_completions', 'messages')
    expect(t).not.toBeNull()
    expect(typeof t!.translateRequest).toBe('function')
    expect(typeof t!.translateEvents).toBe('function')
    expect(typeof t!.translateBody).toBe('function')
  })

  test('messages→chat_completions returns a translator with all three methods', () => {
    const t = getTranslator('messages', 'chat_completions')
    expect(t).not.toBeNull()
    expect(typeof t!.translateRequest).toBe('function')
    expect(typeof t!.translateEvents).toBe('function')
    expect(typeof t!.translateBody).toBe('function')
  })

  test('unsupported pair (messages→embeddings) returns null', () => {
    // 'embeddings' is a valid EndpointKey but no chat-flow translator exists.
    const t = getTranslator('messages', 'embeddings')
    expect(t).toBeNull()
  })

  test('identity translator passes request and events through unchanged', async () => {
    const payload = { model: 'm', messages: [{ role: 'user', content: 'hi' }] }
    const ctx = { signal: new AbortController().signal }
    const out = await IDENTITY_TRANSLATOR.translateRequest(payload, ctx)
    expect(out).toBe(payload)

    async function* gen() { yield { type: 'message_start' as const } }
    const events = IDENTITY_TRANSLATOR.translateEvents(gen(), ctx)
    const collected: unknown[] = []
    for await (const e of events) collected.push(e)
    expect(collected).toEqual([{ type: 'message_start' }])
  })
})
