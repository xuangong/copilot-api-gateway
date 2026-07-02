import { test, expect, describe } from 'bun:test'
import {
  adaptThinkingForModel,
  filterThinkingBlocks,
} from '../src/transforms/thinking-cleanup'
import type { AnthropicMessagesPayload } from '../src/transforms/types'

describe('adaptThinkingForModel', () => {
  describe('claude-haiku-4.5 (rejects reasoning effort)', () => {
    test('strips output_config entirely when present', () => {
      const payload: AnthropicMessagesPayload = {
        model: 'claude-haiku-4.5',
        max_tokens: 20,
        messages: [{ role: 'user', content: 'hi' }],
        output_config: { effort: 'high' },
      }
      adaptThinkingForModel(payload)
      expect(payload.output_config).toBeUndefined()
    })

    test('matches dated variant claude-haiku-4-5-20251001', () => {
      const payload: AnthropicMessagesPayload = {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 20,
        messages: [{ role: 'user', content: 'hi' }],
        output_config: { effort: 'medium' },
      }
      adaptThinkingForModel(payload)
      expect(payload.output_config).toBeUndefined()
    })

    test('converts thinking.type=adaptive back to enabled with default budget', () => {
      const payload: AnthropicMessagesPayload = {
        model: 'claude-haiku-4.5',
        max_tokens: 20,
        messages: [{ role: 'user', content: 'hi' }],
        thinking: { type: 'adaptive' },
      }
      adaptThinkingForModel(payload)
      expect(payload.thinking?.type).toBe('enabled')
      expect(payload.thinking?.budget_tokens).toBe(1024)
    })

    test('preserves existing budget_tokens when converting adaptive→enabled', () => {
      const payload: AnthropicMessagesPayload = {
        model: 'claude-haiku-4.5',
        max_tokens: 20,
        messages: [{ role: 'user', content: 'hi' }],
        thinking: { type: 'adaptive', budget_tokens: 2048 },
      }
      adaptThinkingForModel(payload)
      expect(payload.thinking?.type).toBe('enabled')
      expect(payload.thinking?.budget_tokens).toBe(2048)
    })
  })

  describe('claude 4.7+ models (require thinking.type=adaptive)', () => {
    test('converts thinking.type=enabled→adaptive for claude-opus-4.7', () => {
      const payload: AnthropicMessagesPayload = {
        model: 'claude-opus-4.7',
        max_tokens: 50,
        messages: [{ role: 'user', content: 'hi' }],
        thinking: { type: 'enabled', budget_tokens: 1024 },
      }
      adaptThinkingForModel(payload)
      expect(payload.thinking?.type).toBe('adaptive')
      expect(payload.thinking?.budget_tokens).toBeUndefined()
      expect(payload.output_config?.effort).toBe('medium')
    })

    test('converts thinking.type=enabled→adaptive for claude-opus-4.8', () => {
      const payload: AnthropicMessagesPayload = {
        model: 'claude-opus-4.8',
        max_tokens: 50,
        messages: [{ role: 'user', content: 'hi' }],
        thinking: { type: 'enabled', budget_tokens: 1024 },
      }
      adaptThinkingForModel(payload)
      expect(payload.thinking?.type).toBe('adaptive')
      expect(payload.thinking?.budget_tokens).toBeUndefined()
      expect(payload.output_config?.effort).toBe('medium')
    })

    test('matches dashed dated variant claude-opus-4-8-20251201', () => {
      const payload: AnthropicMessagesPayload = {
        model: 'claude-opus-4-8-20251201',
        max_tokens: 50,
        messages: [{ role: 'user', content: 'hi' }],
        thinking: { type: 'enabled', budget_tokens: 1024 },
      }
      adaptThinkingForModel(payload)
      expect(payload.thinking?.type).toBe('adaptive')
    })

    test('preserves existing output_config.effort when converting', () => {
      const payload: AnthropicMessagesPayload = {
        model: 'claude-opus-4.8',
        max_tokens: 50,
        messages: [{ role: 'user', content: 'hi' }],
        thinking: { type: 'enabled', budget_tokens: 1024 },
        output_config: { effort: 'high' },
      }
      adaptThinkingForModel(payload)
      expect(payload.output_config?.effort).toBe('high')
    })

    test('no-op when thinking already adaptive', () => {
      const payload: AnthropicMessagesPayload = {
        model: 'claude-opus-4.8',
        max_tokens: 50,
        messages: [{ role: 'user', content: 'hi' }],
        thinking: { type: 'adaptive' },
        output_config: { effort: 'low' },
      }
      adaptThinkingForModel(payload)
      expect(payload.thinking?.type).toBe('adaptive')
      expect(payload.output_config?.effort).toBe('low')
    })
  })

  describe('older / unaffected models', () => {
    test('claude-sonnet-4.6 with thinking.enabled is left untouched', () => {
      const payload: AnthropicMessagesPayload = {
        model: 'claude-sonnet-4.6',
        max_tokens: 50,
        messages: [{ role: 'user', content: 'hi' }],
        thinking: { type: 'enabled', budget_tokens: 1024 },
      }
      adaptThinkingForModel(payload)
      expect(payload.thinking?.type).toBe('enabled')
      expect(payload.thinking?.budget_tokens).toBe(1024)
      expect(payload.output_config).toBeUndefined()
    })

    test('claude-opus-4.5 with thinking.enabled is left untouched', () => {
      const payload: AnthropicMessagesPayload = {
        model: 'claude-opus-4.5',
        max_tokens: 50,
        messages: [{ role: 'user', content: 'hi' }],
        thinking: { type: 'enabled', budget_tokens: 1024 },
      }
      adaptThinkingForModel(payload)
      expect(payload.thinking?.type).toBe('enabled')
    })

    test('no-op when no model', () => {
      const payload = {
        model: '',
        max_tokens: 20,
        messages: [{ role: 'user' as const, content: 'hi' }],
        output_config: { effort: 'high' as const },
      }
      adaptThinkingForModel(payload as AnthropicMessagesPayload)
      // empty model -> early return -> field untouched
      expect(payload.output_config?.effort).toBe('high')
    })
  })
})

describe('filterThinkingBlocks', () => {
  test('drops empty thinking and "Thinking..." placeholders from assistant turns', () => {
    const payload: AnthropicMessagesPayload = {
      model: 'claude-opus-4.7',
      max_tokens: 50,
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: '' },
            { type: 'thinking', thinking: 'Thinking...' },
            { type: 'thinking', thinking: 'real reasoning here', signature: 'sig' },
            { type: 'text', text: 'final answer' },
          ],
        },
      ],
    }
    filterThinkingBlocks(payload)
    const content = payload.messages[0].content as Array<{ type: string; thinking?: string; text?: string }>
    expect(content).toHaveLength(2)
    expect(content[0].type).toBe('thinking')
    expect(content[0].thinking).toBe('real reasoning here')
    expect(content[1].type).toBe('text')
  })

  test('leaves user messages untouched', () => {
    const payload: AnthropicMessagesPayload = {
      model: 'claude-opus-4.7',
      max_tokens: 50,
      messages: [{ role: 'user', content: 'hi' }],
    }
    filterThinkingBlocks(payload)
    expect(payload.messages[0].content).toBe('hi')
  })
})
