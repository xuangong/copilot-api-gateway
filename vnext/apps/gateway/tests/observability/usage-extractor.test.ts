import { test, expect } from 'bun:test'
import {
  extractFromJson,
  applyStreamEvent,
  pickUsageModelId,
  type UsageInfo,
} from '../../src/shared/observability/usage-extractor.ts'

test('extractFromJson: Anthropic Messages with cache fields', () => {
  const out = extractFromJson({
    model: 'claude-opus-4-7',
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 200,
      cache_creation_input_tokens: 30,
    },
  })
  expect(out).toEqual({
    model: 'claude-opus-4.7',
    input: 100, output: 50, cacheRead: 200, cacheCreation: 30,
  })
})

test('extractFromJson: Responses input_tokens_details.cached_tokens subtraction', () => {
  const out = extractFromJson({
    response: { model: 'gpt-5' },
    usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 30 } },
  })
  expect(out).toEqual({
    model: 'gpt-5',
    input: 70, output: 20, cacheRead: 30, cacheCreation: 0,
  })
})

test('extractFromJson: OpenAI Chat prompt_tokens', () => {
  const out = extractFromJson({
    model: 'gpt-4o',
    usage: { prompt_tokens: 100, completion_tokens: 25, prompt_tokens_details: { cached_tokens: 10 } },
  })
  expect(out).toEqual({
    model: 'gpt-4o',
    input: 90, output: 25, cacheRead: 10, cacheCreation: 0,
  })
})

test('extractFromJson: returns null when no usage block', () => {
  expect(extractFromJson({ model: 'gpt-4o' })).toBeNull()
  expect(extractFromJson({})).toBeNull()
  expect(extractFromJson(null)).toBeNull()
})

test('pickUsageModelId: caller variant beats less-specific JSON sibling', () => {
  // Anthropic Messages strips -internal — caller is more specific
  expect(pickUsageModelId('claude-opus-4.7', 'claude-opus-4-7-1m-internal'))
    .toBe('claude-opus-4.7-1m-internal')
})

test('pickUsageModelId: caller dash → dot normalization', () => {
  expect(pickUsageModelId(undefined, 'claude-opus-4-7'))
    .toBe('claude-opus-4.7')
})

test('pickUsageModelId: JSON wins for unrelated ids', () => {
  expect(pickUsageModelId('gpt-5.5', 'claude-code-sdk')).toBe('gpt-5.5')
})

test('applyStreamEvent: Anthropic message_start sets input/cache, not terminal', () => {
  const latest: UsageInfo = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }
  const terminal = applyStreamEvent({
    type: 'message_start',
    message: { model: 'claude-opus-4-7', usage: { input_tokens: 50, cache_read_input_tokens: 5, cache_creation_input_tokens: 1 } },
  }, latest)
  expect(terminal).toBe(false)
  expect(latest.input).toBe(50)
  expect(latest.cacheRead).toBe(5)
  expect(latest.cacheCreation).toBe(1)
  expect(latest.model).toBe('claude-opus-4.7')
})

test('applyStreamEvent: Anthropic message_delta accumulates, not terminal', () => {
  const latest: UsageInfo = { input: 50, output: 0, cacheRead: 0, cacheCreation: 0 }
  const terminal = applyStreamEvent({ type: 'message_delta', usage: { output_tokens: 25 } }, latest)
  expect(terminal).toBe(false)
  expect(latest.output).toBe(25)
})

test('applyStreamEvent: Responses response.completed is terminal', () => {
  const latest: UsageInfo = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }
  const terminal = applyStreamEvent({
    type: 'response.completed',
    response: { usage: { input_tokens: 100, output_tokens: 30, input_tokens_details: { cached_tokens: 20 } } },
  }, latest)
  expect(terminal).toBe(true)
  expect(latest.input).toBe(80)
  expect(latest.output).toBe(30)
  expect(latest.cacheRead).toBe(20)
})

test('applyStreamEvent: OpenAI Chat end-frame is terminal', () => {
  const latest: UsageInfo = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }
  const terminal = applyStreamEvent({
    usage: { prompt_tokens: 50, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 5 } },
  }, latest)
  expect(terminal).toBe(true)
  expect(latest.input).toBe(45)
  expect(latest.output).toBe(10)
  expect(latest.cacheRead).toBe(5)
})

test('applyStreamEvent: unrelated event returns false, no mutation', () => {
  const latest: UsageInfo = { input: 1, output: 2, cacheRead: 3, cacheCreation: 4 }
  expect(applyStreamEvent({ type: 'content_block_start' }, latest)).toBe(false)
  expect(latest).toEqual({ input: 1, output: 2, cacheRead: 3, cacheCreation: 4 })
})
