import { describe, test, expect } from 'bun:test'
import { parseEndpoints, normalizeStringRecord } from '../upstream-config.ts'

describe('parseEndpoints', () => {
  test('returns a copy of the fallback when the value is undefined', () => {
    const fallback = ['chat_completions', 'embeddings'] as const
    const out = parseEndpoints(undefined, fallback)
    expect(out).toEqual(['chat_completions', 'embeddings'])
    expect(out).not.toBe(fallback)
  })

  test('rejects a non-array', () => {
    expect(() => parseEndpoints('messages', [])).toThrow(/endpoints must be an array/)
  })

  test('rejects an unknown endpoint name', () => {
    expect(() => parseEndpoints(['not_an_endpoint'], [])).toThrow(/unknown endpoint: not_an_endpoint/)
  })

  test('deduplicates while preserving order', () => {
    expect(parseEndpoints(['messages', 'chat_completions', 'messages'], []))
      .toEqual(['messages', 'chat_completions'])
  })
})

describe('normalizeStringRecord', () => {
  test('returns undefined for undefined', () => {
    expect(normalizeStringRecord(undefined, 'defaultHeaders')).toBeUndefined()
  })

  test('rejects an array', () => {
    expect(() => normalizeStringRecord([], 'defaultHeaders'))
      .toThrow(/defaultHeaders must be an object/)
  })

  test('rejects a non-string value and names the offending key', () => {
    expect(() => normalizeStringRecord({ 'x-a': 1 }, 'defaultHeaders'))
      .toThrow(/defaultHeaders\.x-a must be a string/)
  })

  test('passes a valid record through', () => {
    expect(normalizeStringRecord({ 'x-a': 'b' }, 'defaultHeaders')).toEqual({ 'x-a': 'b' })
  })
})
