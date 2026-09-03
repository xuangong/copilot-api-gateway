import { test, expect } from 'bun:test'
import {
  extractFromJson,
  applyStreamEvent,
  pickUsageModelId,
  tokenUsageFromImagesResponse,
  type UsageInfo,
} from '../../src/data-plane/observability/usage-extractor.ts'

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
    tokens: { input: 100, output: 50, input_cache_read: 200, input_cache_write: 30 },
  })
})

test('extractFromJson: Responses input_tokens_details.cached_tokens subtraction', () => {
  const out = extractFromJson({
    response: { model: 'gpt-5' },
    usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 30 } },
  })
  expect(out).toEqual({
    model: 'gpt-5',
    tokens: { input: 70, output: 20, input_cache_read: 30 },
  })
})

// Both frames below are verbatim from a live Copilot probe on gpt-5.6-sol:
// one ~1.9k-token prompt sent twice. It proves two things at once — Copilot
// *does* report cache writes on the Responses endpoint (the Chat Completions
// path never did, which is why this was missed), and `input_tokens` is the
// inclusive total, so both details must be subtracted to get the bare rate.
test('extractFromJson: Responses cache_write_tokens is subtracted and billed apart', () => {
  const out = extractFromJson({
    response: { model: 'gpt-5.6-sol' },
    usage: {
      input_tokens: 1934,
      output_tokens: 12,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 1931 },
    },
  })
  expect(out).toEqual({
    model: 'gpt-5.6-sol',
    tokens: { input: 3, output: 12, input_cache_write: 1931 },
  })
})

test('extractFromJson: the repeat call reports the same tokens as a cache read', () => {
  const out = extractFromJson({
    response: { model: 'gpt-5.6-sol' },
    usage: {
      input_tokens: 1934,
      output_tokens: 12,
      input_tokens_details: { cached_tokens: 1931, cache_write_tokens: 0 },
    },
  })
  expect(out).toEqual({
    model: 'gpt-5.6-sol',
    tokens: { input: 3, output: 12, input_cache_read: 1931 },
  })
})

test('extractFromJson: OpenAI Chat prompt_tokens', () => {
  const out = extractFromJson({
    model: 'gpt-4o',
    usage: { prompt_tokens: 100, completion_tokens: 25, prompt_tokens_details: { cached_tokens: 10 } },
  })
  expect(out).toEqual({
    model: 'gpt-4o',
    tokens: { input: 90, output: 25, input_cache_read: 10 },
  })
})

test('extractFromJson: OpenAI Chat with cache_creation_input_tokens (Copilot extension)', () => {
  const out = extractFromJson({
    model: 'gpt-5.5',
    usage: {
      prompt_tokens: 1000,
      completion_tokens: 50,
      prompt_tokens_details: { cached_tokens: 100, cache_creation_input_tokens: 200 },
    },
  })
  expect(out).toEqual({
    model: 'gpt-5.5',
    tokens: { input: 700, output: 50, input_cache_read: 100, input_cache_write: 200 },
  })
})

test('extractFromJson: Responses with image-modality split routes via tokenUsageFromImagesResponse', () => {
  const out = extractFromJson({
    response: { model: 'gpt-5' },
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      input_tokens_details: { text_tokens: 80, image_tokens: 20 },
      output_tokens_details: { text_tokens: 30, image_tokens: 20 },
    },
  })
  expect(out).toEqual({
    model: 'gpt-5',
    tokens: { input: 80, input_image: 20, output: 30, output_image: 20 },
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

// Copilot serves gpt-5.6-sol-fast but echoes `"model": "gpt-5.6-sol"` back in
// the response envelope (verified against the live endpoint). Fast costs twice
// the base, so losing the suffix here halves the bill and hides the model from
// the by-model panel entirely.
test('pickUsageModelId: OpenAI fast variant survives an upstream base id', () => {
  expect(pickUsageModelId('gpt-5.6-sol', 'gpt-5.6-sol-fast')).toBe('gpt-5.6-sol-fast')
})

test('pickUsageModelId: a shared prefix that is not a dashed suffix does not merge', () => {
  // `gpt-5.6-solar` is not `gpt-5.6-sol` + "-<variant>"; treating it as one
  // would attribute a different model's spend to Sol.
  expect(pickUsageModelId('gpt-5.6-solar', 'gpt-5.6-sol')).toBe('gpt-5.6-solar')
})

test('pickUsageModelId: JSON wins for unrelated ids', () => {
  expect(pickUsageModelId('gpt-5.5', 'claude-code-sdk')).toBe('gpt-5.5')
})

test('applyStreamEvent: Anthropic message_start sets input/cache, not terminal', () => {
  const latest: UsageInfo = { tokens: {} }
  const terminal = applyStreamEvent({
    type: 'message_start',
    message: { model: 'claude-opus-4-7', usage: { input_tokens: 50, cache_read_input_tokens: 5, cache_creation_input_tokens: 1 } },
  }, latest)
  expect(terminal).toBe(false)
  expect(latest.tokens.input).toBe(50)
  expect(latest.tokens.input_cache_read).toBe(5)
  expect(latest.tokens.input_cache_write).toBe(1)
  expect(latest.model).toBe('claude-opus-4.7')
})

test('applyStreamEvent: Anthropic message_delta accumulates, not terminal', () => {
  const latest: UsageInfo = { tokens: { input: 50 } }
  const terminal = applyStreamEvent({ type: 'message_delta', usage: { output_tokens: 25 } }, latest)
  expect(terminal).toBe(false)
  expect(latest.tokens.output).toBe(25)
  expect(latest.tokens.input).toBe(50)
})

test('applyStreamEvent: Anthropic message_delta ignores invalid input counts', () => {
  for (const invalid of ['17', Number.POSITIVE_INFINITY, Number.NaN]) {
    const latest: UsageInfo = { tokens: { input: 50 } }
    applyStreamEvent({
      type: 'message_delta',
      usage: { input_tokens: invalid, output_tokens: 7 },
    }, latest)
    expect(latest.tokens).toEqual({ input: 50, output: 7 })
  }
})

test('applyStreamEvent: Anthropic message_delta zero does not erase known input', () => {
  const latest: UsageInfo = { tokens: {} }
  applyStreamEvent({
    type: 'message_start',
    message: { model: 'claude-sonnet-4.6', usage: { input_tokens: 50, output_tokens: 0 } },
  }, latest)

  applyStreamEvent({
    type: 'message_delta',
    usage: { input_tokens: 0, output_tokens: 7 },
  }, latest)

  expect(latest.tokens).toEqual({ input: 50, output: 7 })
})

test('applyStreamEvent: Anthropic message_delta replaces provisional input with terminal usage', () => {
  const latest: UsageInfo = { tokens: {} }
  applyStreamEvent({
    type: 'message_start',
    message: { model: 'gpt-5.6-sol', usage: { input_tokens: 0, output_tokens: 0 } },
  }, latest)

  // Responses does not report usage on response.created, so the Messages
  // translator can only put a provisional zero in message_start. It restates
  // the final prompt split on message_delta once response.completed arrives.
  const terminal = applyStreamEvent({
    type: 'message_delta',
    usage: {
      input_tokens: 3_440,
      output_tokens: 6,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 35_273,
    },
  }, latest)

  expect(terminal).toBe(false)
  expect(latest.tokens).toEqual({ input: 3_440, output: 6, input_cache_write: 35_273 })
})

test('applyStreamEvent: Responses response.completed is terminal', () => {
  const latest: UsageInfo = { tokens: {} }
  const terminal = applyStreamEvent({
    type: 'response.completed',
    response: { usage: { input_tokens: 100, output_tokens: 30, input_tokens_details: { cached_tokens: 20 } } },
  }, latest)
  expect(terminal).toBe(true)
  expect(latest.tokens.input).toBe(80)
  expect(latest.tokens.output).toBe(30)
  expect(latest.tokens.input_cache_read).toBe(20)
})

test('applyStreamEvent: Responses response.completed splits out cache writes', () => {
  const latest: UsageInfo = { tokens: {} }
  const terminal = applyStreamEvent({
    type: 'response.completed',
    response: {
      usage: {
        input_tokens: 1934,
        output_tokens: 12,
        input_tokens_details: { cached_tokens: 0, cache_write_tokens: 1931 },
      },
    },
  }, latest)
  expect(terminal).toBe(true)
  expect(latest.tokens.input).toBe(3)
  expect(latest.tokens.input_cache_write).toBe(1931)
})

test('applyStreamEvent: Responses response.completed with image-modality split is terminal', () => {
  const latest: UsageInfo = { tokens: {} }
  const terminal = applyStreamEvent({
    type: 'response.completed',
    response: {
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        input_tokens_details: { text_tokens: 80, image_tokens: 20 },
        output_tokens_details: { text_tokens: 30, image_tokens: 20 },
      },
    },
  }, latest)
  expect(terminal).toBe(true)
  expect(latest.tokens).toEqual({ input: 80, input_image: 20, output: 30, output_image: 20 })
})

test('applyStreamEvent: OpenAI Chat end-frame is terminal', () => {
  const latest: UsageInfo = { tokens: {} }
  const terminal = applyStreamEvent({
    usage: { prompt_tokens: 50, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 5 } },
  }, latest)
  expect(terminal).toBe(true)
  expect(latest.tokens.input).toBe(45)
  expect(latest.tokens.output).toBe(10)
  expect(latest.tokens.input_cache_read).toBe(5)
})

test('applyStreamEvent: OpenAI Chat end-frame with cache_creation_input_tokens', () => {
  const latest: UsageInfo = { tokens: {} }
  const terminal = applyStreamEvent({
    usage: {
      prompt_tokens: 1000,
      completion_tokens: 25,
      prompt_tokens_details: { cached_tokens: 100, cache_creation_input_tokens: 200 },
    },
  }, latest)
  expect(terminal).toBe(true)
  expect(latest.tokens).toEqual({ input: 700, output: 25, input_cache_read: 100, input_cache_write: 200 })
})

test('applyStreamEvent: unrelated event returns false, no mutation', () => {
  const latest: UsageInfo = { tokens: { input: 1, output: 2, input_cache_read: 3, input_cache_write: 4 } }
  expect(applyStreamEvent({ type: 'content_block_start' }, latest)).toBe(false)
  expect(latest.tokens).toEqual({ input: 1, output: 2, input_cache_read: 3, input_cache_write: 4 })
})

test('tokenUsageFromImagesResponse: splits text/image counts via details', () => {
  expect(tokenUsageFromImagesResponse({
    input_tokens: 100, output_tokens: 50,
    input_tokens_details: { text_tokens: 80, image_tokens: 20 },
    output_tokens_details: { text_tokens: 30, image_tokens: 20 },
  })).toEqual({ input: 80, input_image: 20, output: 30, output_image: 20 })
})

test('tokenUsageFromImagesResponse: missing details charges total to bare dim', () => {
  expect(tokenUsageFromImagesResponse({ input_tokens: 100, output_tokens: 50 }))
    .toEqual({ input: 100, output: 50 })
})

test('tokenUsageFromImagesResponse: malformed (non-number) → null', () => {
  expect(tokenUsageFromImagesResponse({ input_tokens: 'huh', output_tokens: 50 })).toBeNull()
})

test('tokenUsageFromImagesResponse: null/non-object → null', () => {
  expect(tokenUsageFromImagesResponse(null)).toBeNull()
  expect(tokenUsageFromImagesResponse('x')).toBeNull()
})
