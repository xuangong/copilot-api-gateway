/**
 * Adapted from reference copilot-gateway c8995129d (#703): Gemini's wire enum
 * for `thinkingLevel` is uppercase (LOW/MEDIUM/HIGH/MINIMAL), which targets do
 * not understand; the default sentinel leaves effort unset and unknown values
 * stay verbatim (open-string protocol values are upstream-owned).
 */
import { describe, it, expect } from 'bun:test'
import { translateGeminiToChat } from '@vibe-llm/translate/gemini-via-chat-completions'
import { translateGeminiToResponses } from '@vibe-llm/translate/gemini-via-responses'
import { translateGeminiToMessages } from '@vibe-llm/translate/gemini-via-messages'

const req = (thinkingLevel: string) => ({
  contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
  generationConfig: { thinkingConfig: { thinkingLevel } },
})

const cases: Array<[string, string | undefined]> = [
  ['LOW', 'low'],
  ['MEDIUM', 'medium'],
  ['HIGH', 'high'],
  ['MINIMAL', 'minimal'],
  ['THINKING_LEVEL_UNSPECIFIED', undefined],
  ['VENDOR_Turbo', 'VENDOR_Turbo'],
]

describe('Gemini thinkingLevel enum', () => {
  it.each(cases)('Chat target: %s -> reasoning_effort %s', (level, effort) => {
    const out = translateGeminiToChat(req(level) as never, { model: 'm' }) as unknown as { reasoning_effort?: string }
    expect(out.reasoning_effort).toBe(effort)
  })

  it.each(cases)('Responses target: %s -> reasoning.effort %s', (level, effort) => {
    const out = translateGeminiToResponses(req(level) as never, { model: 'm' }) as unknown as { reasoning?: { effort?: string } }
    expect(out.reasoning?.effort).toBe(effort)
  })

  it.each(cases)('Messages target: %s -> effort %s', (level, effort) => {
    const out = translateGeminiToMessages(req(level) as never, { model: 'm' }) as unknown as Record<string, unknown>
    const got = (out.output_config as { effort?: string } | undefined)?.effort ?? (out.reasoning_effort as string | undefined)
    expect(got).toBe(effort)
  })
})
