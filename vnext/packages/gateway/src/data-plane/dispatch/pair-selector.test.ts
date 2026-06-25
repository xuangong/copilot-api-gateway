/**
 * pair-selector — chooses the target endpoint for a given client source API
 * based on a fixed per-source preference chain. The selector is the routing
 * primitive for the pairwise pipeline introduced in Phase B (X-5).
 *
 * Preference rationale (per plan §5.1):
 *   - messages clients prefer messages → responses → chat_completions
 *   - chat clients prefer chat_completions → messages → responses
 *   - responses clients prefer responses → messages → chat_completions
 *   - gemini clients prefer messages → responses → chat_completions
 *     (The only registered Gemini pair is gemini ↔ messages — we therefore
 *      route Gemini source through the messages hub whenever the binding
 *      serves it, falling back to responses or chat_completions only if no
 *      messages endpoint is available.)
 *
 * A returned null means no supported endpoint exists for the source; the
 * caller (enumerateBindingCandidates) treats that as "client protocol
 * unsupported" (HTTP 400) when sawModel is true.
 */
import { test, expect, describe } from 'bun:test'
import type { ModelEndpoints } from '@vibe-llm/protocols/common'
import { selectPair } from './pair-selector.ts'

const all: ModelEndpoints = {
  messages: {},
  chat_completions: {},
  responses: {},
}

describe('selectPair', () => {
  test('messages source prefers messages target when available', () => {
    expect(selectPair('messages', all)).toBe('messages')
  })

  test('messages source falls back to responses when no messages endpoint', () => {
    expect(selectPair('messages', { responses: {}, chat_completions: {} })).toBe('responses')
  })

  test('chat_completions source prefers chat_completions then messages then responses', () => {
    expect(selectPair('chat_completions', all)).toBe('chat_completions')
    expect(selectPair('chat_completions', { messages: {}, responses: {} })).toBe('messages')
    expect(selectPair('chat_completions', { responses: {} })).toBe('responses')
  })

  test('responses source prefers responses then messages then chat_completions', () => {
    expect(selectPair('responses', all)).toBe('responses')
    expect(selectPair('responses', { messages: {}, chat_completions: {} })).toBe('messages')
    expect(selectPair('responses', { chat_completions: {} })).toBe('chat_completions')
  })

  test('gemini source prefers messages (only registered Gemini pair) then responses then chat_completions', () => {
    expect(selectPair('gemini', all)).toBe('messages')
    expect(selectPair('gemini', { responses: {}, chat_completions: {} })).toBe('responses')
    expect(selectPair('gemini', { chat_completions: {} })).toBe('chat_completions')
  })

  test('returns null when no supported endpoint exists for source', () => {
    expect(selectPair('messages', { embeddings: {} })).toBeNull()
    expect(selectPair('chat_completions', {})).toBeNull()
  })
})
