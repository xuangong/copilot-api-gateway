import { describe, test, expect } from 'bun:test'
import { getTranslator } from '../../src/data-plane/dispatch/translator-registry.ts'

describe('translator-registry: chat↔responses pairs', () => {
  test('chat_completions→responses returns a translator', () => {
    const t = getTranslator('chat_completions', 'responses')
    expect(t).not.toBeNull()
    expect(typeof t!.translateRequest).toBe('function')
  })
  test('responses→chat_completions returns a translator', () => {
    const t = getTranslator('responses', 'chat_completions')
    expect(t).not.toBeNull()
  })
})
