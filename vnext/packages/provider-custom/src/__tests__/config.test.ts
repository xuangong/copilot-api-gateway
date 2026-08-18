import { describe, test, expect } from 'bun:test'
import {
  CUSTOM_AUTH_STYLES,
  CUSTOM_PATH_OVERRIDE_KEYS,
  validateUpstreamPath,
} from '../config.ts'

describe('CUSTOM_PATH_OVERRIDE_KEYS', () => {
  test('covers the seven overridable endpoints', () => {
    expect([...CUSTOM_PATH_OVERRIDE_KEYS]).toEqual([
      'chat_completions',
      'responses',
      'messages',
      'embeddings',
      'images_generations',
      'images_edits',
      'alpha_search',
    ])
  })

  test('excludes messages_count_tokens because it derives from messages', () => {
    expect(CUSTOM_PATH_OVERRIDE_KEYS).not.toContain('messages_count_tokens')
  })
})

describe('CUSTOM_AUTH_STYLES', () => {
  test('is exactly bearer/anthropic/none', () => {
    expect([...CUSTOM_AUTH_STYLES]).toEqual(['bearer', 'anthropic', 'none'])
  })
})

describe('validateUpstreamPath', () => {
  test('accepts a plain absolute path', () => {
    expect(validateUpstreamPath('/anthropic/v1/messages', 'pathOverrides.messages'))
      .toBe('/anthropic/v1/messages')
  })

  test('trims surrounding whitespace', () => {
    expect(validateUpstreamPath('  /messages  ', 'p')).toBe('/messages')
  })

  test('rejects a non-string', () => {
    expect(() => validateUpstreamPath(42, 'p')).toThrow(/p must be a string/)
  })

  test('rejects an empty string', () => {
    expect(() => validateUpstreamPath('   ', 'p')).toThrow(/p must not be empty/)
  })

  test('rejects a path without a leading slash', () => {
    expect(() => validateUpstreamPath('v1/messages', 'p')).toThrow(/p must start with \//)
  })

  test('rejects a path longer than 256 chars', () => {
    expect(() => validateUpstreamPath('/' + 'a'.repeat(256), 'p')).toThrow(/p is too long/)
  })

  test('rejects a double slash', () => {
    expect(() => validateUpstreamPath('/a//b', 'p')).toThrow(/must not contain/)
  })

  test('rejects a single-dot segment', () => {
    expect(() => validateUpstreamPath('/a/./b', 'p')).toThrow(/must not contain/)
  })

  test('rejects traversal — this is the security boundary', () => {
    expect(() => validateUpstreamPath('/../../admin', 'p')).toThrow(/must not contain/)
  })
})
