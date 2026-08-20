import { describe, test, expect } from 'bun:test'
import { isOpenAIUsageOnlyEventShape } from '../openai-stream'

const usage = { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 }

describe('isOpenAIUsageOnlyEventShape', () => {
  test('accepts the vanilla OpenAI / vLLM shape: empty choices + usage', () => {
    expect(isOpenAIUsageOnlyEventShape({ object: 'chat.completion.chunk', choices: [], usage })).toBe(true)
  })

  test('accepts the Zhipu/GLM vLLM fork shape: a placeholder choice + usage', () => {
    expect(
      isOpenAIUsageOnlyEventShape({ object: 'chat.completion.chunk', choices: [{ index: 0 }], usage }),
    ).toBe(true)
  })

  test('accepts a placeholder choice carrying an explicitly empty delta', () => {
    expect(isOpenAIUsageOnlyEventShape({ choices: [{ index: 0, delta: {} }], usage })).toBe(true)
  })

  test('accepts a placeholder choice carrying explicit nulls', () => {
    expect(
      isOpenAIUsageOnlyEventShape({ choices: [{ index: 0, delta: null, finish_reason: null }], usage }),
    ).toBe(true)
  })

  test('rejects a content chunk that also carries usage', () => {
    expect(
      isOpenAIUsageOnlyEventShape({ choices: [{ index: 0, delta: { content: 'hi' } }], usage }),
    ).toBe(false)
  })

  test('rejects the terminal content chunk, which carries finish_reason', () => {
    expect(
      isOpenAIUsageOnlyEventShape({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage }),
    ).toBe(false)
  })

  test('rejects a legacy completions chunk carrying text', () => {
    expect(isOpenAIUsageOnlyEventShape({ choices: [{ index: 0, text: 'hi' }], usage })).toBe(false)
  })

  test('rejects a chunk with no usage at all', () => {
    expect(isOpenAIUsageOnlyEventShape({ choices: [] })).toBe(false)
  })

  test('rejects a chunk whose usage is null, as OpenAI sends on every content chunk', () => {
    expect(isOpenAIUsageOnlyEventShape({ choices: [{ index: 0, delta: { content: 'hi' } }], usage: null })).toBe(false)
  })

  test("rejects the Azure prompt_filter_results frame: empty choices but no usage", () => {
    expect(
      isOpenAIUsageOnlyEventShape({ choices: [], prompt_filter_results: [{ prompt_index: 0 }] }),
    ).toBe(false)
  })

  test('rejects a chunk whose choices is not an array', () => {
    expect(isOpenAIUsageOnlyEventShape({ choices: 'nope', usage })).toBe(false)
    expect(isOpenAIUsageOnlyEventShape({ usage })).toBe(false)
  })

  test('rejects a choice element that is not an object', () => {
    expect(isOpenAIUsageOnlyEventShape({ choices: [null], usage })).toBe(false)
    expect(isOpenAIUsageOnlyEventShape({ choices: ['x'], usage })).toBe(false)
  })

  test('rejects a choice whose delta is a non-object', () => {
    expect(isOpenAIUsageOnlyEventShape({ choices: [{ index: 0, delta: 'x' }], usage })).toBe(false)
  })

  test('rejects non-objects', () => {
    expect(isOpenAIUsageOnlyEventShape(null)).toBe(false)
    expect(isOpenAIUsageOnlyEventShape(undefined)).toBe(false)
    expect(isOpenAIUsageOnlyEventShape('chunk')).toBe(false)
  })

  test('rejects a mixed array where only some choices are placeholders', () => {
    expect(
      isOpenAIUsageOnlyEventShape({
        choices: [{ index: 0 }, { index: 1, delta: { content: 'hi' } }],
        usage,
      }),
    ).toBe(false)
  })
})
