import { test, expect, describe } from 'bun:test'
import {
  adaptThinkingForModel,
  filterThinkingBlocks,
} from '../src/transforms/thinking-cleanup'
import type { AnthropicMessagesPayload } from '../src/transforms/types'

// Capability shapes as observed on Copilot's live /models (2026-08-24):
//   claude-opus-5 / 4.8 / 4.7 / 4.6, claude-sonnet-5 / 4.6
//     → adaptive_thinking: true, reasoning_effort: [...]
//   claude-haiku-4.5
//     → neither key present
const ADAPTIVE_CAPS = { adaptiveThinking: true, reasoningEffort: true }
const NO_REASONING_CAPS = { adaptiveThinking: false, reasoningEffort: false }

describe('adaptThinkingForModel', () => {
  describe('models without reasoning_effort support (e.g. claude-haiku-4.5)', () => {
    test('strips output_config entirely when present', () => {
      const payload: AnthropicMessagesPayload = {
        model: 'claude-haiku-4.5',
        max_tokens: 20,
        messages: [{ role: 'user', content: 'hi' }],
        output_config: { effort: 'high' },
      }
      adaptThinkingForModel(payload, NO_REASONING_CAPS)
      expect(payload.output_config).toBeUndefined()
    })

    test('converts thinking.type=adaptive back to enabled with default budget', () => {
      const payload: AnthropicMessagesPayload = {
        model: 'claude-haiku-4.5',
        max_tokens: 20,
        messages: [{ role: 'user', content: 'hi' }],
        thinking: { type: 'adaptive' },
      }
      adaptThinkingForModel(payload, NO_REASONING_CAPS)
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
      adaptThinkingForModel(payload, NO_REASONING_CAPS)
      expect(payload.thinking?.type).toBe('enabled')
      expect(payload.thinking?.budget_tokens).toBe(2048)
    })
  })

  describe('models advertising adaptive_thinking', () => {
    test('converts thinking.type=enabled→adaptive for claude-opus-5', () => {
      const payload: AnthropicMessagesPayload = {
        model: 'claude-opus-5',
        max_tokens: 50,
        messages: [{ role: 'user', content: 'hi' }],
        thinking: { type: 'enabled', budget_tokens: 1024 },
      }
      adaptThinkingForModel(payload, ADAPTIVE_CAPS)
      expect(payload.thinking?.type).toBe('adaptive')
      expect(payload.thinking?.budget_tokens).toBeUndefined()
      expect(payload.output_config?.effort).toBe('medium')
    })

    test('converts for claude-fable-5, whose family the old regex never listed', () => {
      const payload: AnthropicMessagesPayload = {
        model: 'claude-fable-5',
        max_tokens: 50,
        messages: [{ role: 'user', content: 'hi' }],
        thinking: { type: 'enabled', budget_tokens: 1024 },
      }
      adaptThinkingForModel(payload, ADAPTIVE_CAPS)
      expect(payload.thinking?.type).toBe('adaptive')
    })

    test('converts thinking.type=enabled→adaptive for claude-opus-4.8', () => {
      const payload: AnthropicMessagesPayload = {
        model: 'claude-opus-4.8',
        max_tokens: 50,
        messages: [{ role: 'user', content: 'hi' }],
        thinking: { type: 'enabled', budget_tokens: 1024 },
      }
      adaptThinkingForModel(payload, ADAPTIVE_CAPS)
      expect(payload.thinking?.type).toBe('adaptive')
      expect(payload.thinking?.budget_tokens).toBeUndefined()
      expect(payload.output_config?.effort).toBe('medium')
    })

    test('preserves existing output_config.effort when converting', () => {
      const payload: AnthropicMessagesPayload = {
        model: 'claude-opus-4.8',
        max_tokens: 50,
        messages: [{ role: 'user', content: 'hi' }],
        thinking: { type: 'enabled', budget_tokens: 1024 },
        output_config: { effort: 'high' },
      }
      adaptThinkingForModel(payload, ADAPTIVE_CAPS)
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
      adaptThinkingForModel(payload, ADAPTIVE_CAPS)
      expect(payload.thinking?.type).toBe('adaptive')
      expect(payload.output_config?.effort).toBe('low')
    })
  })

  describe('models with reasoning_effort but no adaptive_thinking', () => {
    test('leaves thinking.enabled untouched and keeps output_config', () => {
      const payload: AnthropicMessagesPayload = {
        model: 'claude-sonnet-4.5',
        max_tokens: 50,
        messages: [{ role: 'user', content: 'hi' }],
        thinking: { type: 'enabled', budget_tokens: 1024 },
        output_config: { effort: 'high' },
      }
      adaptThinkingForModel(payload, { adaptiveThinking: false, reasoningEffort: true })
      expect(payload.thinking?.type).toBe('enabled')
      expect(payload.thinking?.budget_tokens).toBe(1024)
      expect(payload.output_config?.effort).toBe('high')
    })
  })

  describe('no capability metadata available', () => {
    // Deliberate: an upstream whose /models we could not read gets today's
    // behaviour (pass through untouched) rather than a guess.
    test('leaves the payload alone when caps are undefined', () => {
      const payload: AnthropicMessagesPayload = {
        model: 'claude-opus-5',
        max_tokens: 50,
        messages: [{ role: 'user', content: 'hi' }],
        thinking: { type: 'enabled', budget_tokens: 1024 },
      }
      adaptThinkingForModel(payload, undefined)
      expect(payload.thinking?.type).toBe('enabled')
      expect(payload.thinking?.budget_tokens).toBe(1024)
      expect(payload.output_config).toBeUndefined()
    })

    test('no-op when no model', () => {
      const payload = {
        model: '',
        max_tokens: 20,
        messages: [{ role: 'user' as const, content: 'hi' }],
        output_config: { effort: 'high' as const },
      }
      adaptThinkingForModel(payload as AnthropicMessagesPayload, NO_REASONING_CAPS)
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
