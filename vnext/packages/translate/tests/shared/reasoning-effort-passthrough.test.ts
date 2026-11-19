/**
 * Adapted from reference copilot-gateway 0d3f98033 (#619): a supplied effort is the caller's value
 * even when it is the empty string (open-string protocol values are forwarded verbatim); truthiness
 * checks silently dropped it. Chat <-> Responses did not forward effort at all.
 */
import { describe, it, expect } from 'bun:test'
import { translateChatToMessages } from '@vibe-llm/translate/chat-completions-via-messages'
import { translateChatToResponses } from '@vibe-llm/translate/chat-completions-via-responses'
import { translateMessagesToChat } from '@vibe-llm/translate/messages-via-chat-completions'
import { translateMessagesToResponses } from '@vibe-llm/translate/messages-via-responses'
import { translateResponsesToChat } from '@vibe-llm/translate/responses-via-chat-completions'
import { translateResponsesToMessages } from '@vibe-llm/translate/responses-via-messages'
import { translateGeminiToChat } from '@vibe-llm/translate/gemini-via-chat-completions'
import { translateGeminiToResponses } from '@vibe-llm/translate/gemini-via-responses'
import { translateGeminiToMessages } from '@vibe-llm/translate/gemini-via-messages'

const chatBase = { model: 'm', messages: [{ role: 'user', content: 'hi' }] }
const messagesBase = { model: 'm', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] }
const geminiBase = { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }
const gemini = (thinkingLevel: string) => ({ ...geminiBase, generationConfig: { thinkingConfig: { thinkingLevel } } }) as never

const cases: Array<[string, (effort: string) => unknown]> = [
  ['Chat -> Messages', (e) => (translateChatToMessages({ ...chatBase, reasoning_effort: e } as never) as { output_config?: { effort?: string } }).output_config?.effort],
  ['Chat -> Responses', (e) => (translateChatToResponses({ ...chatBase, reasoning_effort: e } as never).target as { reasoning?: { effort?: string } }).reasoning?.effort],
  ['Messages -> Chat', (e) => translateMessagesToChat({ ...messagesBase, output_config: { effort: e } } as never).reasoning_effort],
  ['Messages -> Responses', (e) => translateMessagesToResponses({ ...messagesBase, output_config: { effort: e } } as never).target.reasoning?.effort],
  ['Responses -> Chat', (e) => (translateResponsesToChat({ model: 'm', input: 'hi', reasoning: { effort: e } } as never).target as { reasoning_effort?: string }).reasoning_effort],
  ['Responses -> Messages', (e) => (translateResponsesToMessages({ model: 'm', input: 'hi', reasoning: { effort: e } } as never).target as { output_config?: { effort?: string } }).output_config?.effort],
  ['Gemini -> Chat', (e) => (translateGeminiToChat(gemini(e), { model: 'm' } as never) as { reasoning_effort?: string }).reasoning_effort],
  ['Gemini -> Responses', (e) => (translateGeminiToResponses(gemini(e), { model: 'm' } as never) as { reasoning?: { effort?: string } }).reasoning?.effort],
  ['Gemini -> Messages', (e) => (translateGeminiToMessages(gemini(e), { model: 'm' } as never) as { output_config?: { effort?: string } }).output_config?.effort],
]

describe('reasoning effort is forwarded verbatim', () => {
  it.each(cases)('%s: empty string passes through', (_name, run) => {
    expect(run('')).toBe('')
  })
  it.each(cases)('%s: vendor-specific value passes through', (_name, run) => {
    expect(run('vendor-level')).toBe('vendor-level')
  })
})
