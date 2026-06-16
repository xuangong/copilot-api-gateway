// vnext/packages/gateway/tests/observability/usage-extractor-gemini.test.ts
/**
 * Coverage for the gemini `usageMetadata` branch in `applyStreamEvent`.
 *
 * Gemini's terminal frame carries usage on a top-level `usageMetadata` object
 * (NOT under `usage` like every other source). The branch must:
 *   - subtract `cachedContentTokenCount` from `promptTokenCount` (legacy
 *     hub convention: `input` excludes cached read, which goes to
 *     `input_cache_read`)
 *   - map `candidatesTokenCount` → `output`
 *   - return `true` (terminal — the gemini final frame is the end of the
 *     stream)
 *
 * The branch must live ABOVE the OpenAI `usage.prompt_tokens` fallthrough,
 * since gemini frames may carry both shapes from upstreams that proxy
 * gemini-via-openai (unusual but possible) — the gemini-shape probe wins
 * because the source-specific extractor is more precise.
 */
import { test, expect } from 'bun:test'
import {
  applyStreamEvent,
  type UsageInfo,
} from '../../src/shared/observability/usage-extractor.ts'

test('applyStreamEvent: gemini usageMetadata branch sets input/output/cache_read and is terminal', () => {
  const latest: UsageInfo = { tokens: {} }
  const terminal = applyStreamEvent({
    candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3, cachedContentTokenCount: 2 },
    modelVersion: 'gemini-2.5-pro',
  }, latest)
  expect(terminal).toBe(true)
  expect(latest.tokens.input).toBe(5)
  expect(latest.tokens.output).toBe(3)
  expect(latest.tokens.input_cache_read).toBe(2)
})

test('applyStreamEvent: gemini usageMetadata without cached_content_token_count → input == promptTokenCount, no cache_read', () => {
  const latest: UsageInfo = { tokens: {} }
  const terminal = applyStreamEvent({
    candidates: [{ content: { parts: [{ text: 'a' }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2 },
    modelVersion: 'gemini-2.5-pro',
  }, latest)
  expect(terminal).toBe(true)
  expect(latest.tokens.input).toBe(4)
  expect(latest.tokens.output).toBe(2)
  // compactTokens drops zero dimensions — `input_cache_read` shouldn't appear.
  expect(latest.tokens.input_cache_read).toBeUndefined()
})

test('applyStreamEvent: gemini frame without usageMetadata is NOT terminal (no usage written)', () => {
  const latest: UsageInfo = { tokens: { input: 1 } }
  const terminal = applyStreamEvent({
    candidates: [{ content: { parts: [{ text: 'hi' }] } }],
    modelVersion: 'gemini-2.5-pro',
  }, latest)
  expect(terminal).toBe(false)
  // Pre-existing tokens left untouched.
  expect(latest.tokens.input).toBe(1)
})
