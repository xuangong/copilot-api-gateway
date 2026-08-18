import { describe, test, expect } from 'bun:test'
import {
  CUSTOM_AUTH_STYLES,
  CUSTOM_PATH_OVERRIDE_KEYS,
  normalizeCustomConfig,
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

  // --- trailing-segment bypass cases (Critical fix) ---
  test('rejects trailing /.. (no trailing slash)', () => {
    expect(() => validateUpstreamPath('/foo/..', 'p')).toThrow(/must not contain/)
  })

  test('rejects trailing /. (no trailing slash)', () => {
    expect(() => validateUpstreamPath('/foo/.', 'p')).toThrow(/must not contain/)
  })

  // --- boundary-value pass case (Important fix) ---
  test('accepts a path of exactly 256 characters', () => {
    const path = '/' + 'a'.repeat(255)
    expect(path.length).toBe(256)
    expect(validateUpstreamPath(path, 'p')).toBe(path)
  })

  // --- must NOT mis-reject legitimate paths ---
  test('accepts /v1/models.json', () => {
    expect(validateUpstreamPath('/v1/models.json', 'p')).toBe('/v1/models.json')
  })

  test('accepts /a.b/c', () => {
    expect(validateUpstreamPath('/a.b/c', 'p')).toBe('/a.b/c')
  })

  test('accepts /anthropic/v1/messages', () => {
    expect(validateUpstreamPath('/anthropic/v1/messages', 'p')).toBe('/anthropic/v1/messages')
  })

  // --- percent-encoding bypass cases ---
  test('rejects percent-encoded dot-dot (%2e%2e)', () => {
    expect(() => validateUpstreamPath('/api/%2e%2e/admin', 'p')).toThrow(/must not contain percent-encoding/)
  })

  test('rejects percent-encoded slash (%2f)', () => {
    expect(() => validateUpstreamPath('/a%2fb', 'p')).toThrow(/must not contain percent-encoding/)
  })
})

describe('normalizeCustomConfig', () => {
  const base = { name: 'ds', baseUrl: 'https://api.deepseek.com/v1/', apiKey: 'sk-1' }

  test('trims the name and strips trailing slashes from baseUrl', () => {
    const out = normalizeCustomConfig({ ...base, name: '  ds  ' })
    expect(out.name).toBe('ds')
    expect(out.baseUrl).toBe('https://api.deepseek.com/v1')
  })

  test('defaults endpoints to chat_completions + embeddings', () => {
    expect(normalizeCustomConfig({ ...base }).endpoints).toEqual(['chat_completions', 'embeddings'])
  })

  test('requires a name', () => {
    expect(() => normalizeCustomConfig({ ...base, name: '  ' })).toThrow(/config.name required/)
  })

  test('requires a baseUrl', () => {
    expect(() => normalizeCustomConfig({ ...base, baseUrl: '' })).toThrow(/config.baseUrl required/)
  })

  test('defaults authStyle to bearer', () => {
    expect(normalizeCustomConfig({ ...base }).authStyle).toBe('bearer')
  })

  test('rejects an unknown authStyle', () => {
    expect(() => normalizeCustomConfig({ ...base, authStyle: 'x-api-key' }))
      .toThrow(/config.authStyle must be one of bearer, anthropic, none/)
  })

  test('requires an apiKey when authStyle is bearer', () => {
    expect(() => normalizeCustomConfig({ ...base, apiKey: '' })).toThrow(/config.apiKey required/)
  })

  test('allows a missing apiKey when authStyle is none', () => {
    const out = normalizeCustomConfig({ name: 'x', baseUrl: 'https://x', authStyle: 'none' })
    expect(out.authStyle).toBe('none')
    expect(out.apiKey).toBeUndefined()
  })

  test('accepts and preserves valid pathOverrides', () => {
    const out = normalizeCustomConfig({
      ...base,
      pathOverrides: { messages: '/anthropic/v1/messages' },
    })
    expect(out.pathOverrides).toEqual({ messages: '/anthropic/v1/messages' })
  })

  test('drops an empty pathOverrides object', () => {
    expect(normalizeCustomConfig({ ...base, pathOverrides: {} }).pathOverrides).toBeUndefined()
  })

  test('rejects an unknown pathOverrides key and lists the valid ones', () => {
    expect(() => normalizeCustomConfig({ ...base, pathOverrides: { bogus: '/x' } }))
      .toThrow(/unknown pathOverrides key: bogus \(expected one of chat_completions, responses, messages, embeddings, images_generations, images_edits, alpha_search\)/)
  })

  test('rejects messages_count_tokens and explains the derivation', () => {
    expect(() => normalizeCustomConfig({
      ...base,
      pathOverrides: { messages_count_tokens: '/x/count_tokens' },
    })).toThrow(/derived from the messages path/)
  })

  test('rejects a traversal path override', () => {
    expect(() => normalizeCustomConfig({ ...base, pathOverrides: { messages: '/../admin' } }))
      .toThrow(/must not contain/)
  })

  test('rejects a non-object pathOverrides', () => {
    expect(() => normalizeCustomConfig({ ...base, pathOverrides: [] }))
      .toThrow(/pathOverrides must be an object/)
  })

  test('coerces manual models from both string and object form', () => {
    const out = normalizeCustomConfig({ ...base, models: ['m1', { id: 'm2', name: 'Two' }] })
    expect(out.models).toEqual([{ id: 'm1' }, { id: 'm2', name: 'Two', ownedBy: undefined }])
  })

  test('accepts pricing-only model entries', () => {
    const out = normalizeCustomConfig({
      ...base,
      models: [{ upstreamModelId: 'deepseek-chat', cost: { input: 0.27, output: 1.1 } }],
    })
    expect(out.models).toEqual([
      { upstreamModelId: 'deepseek-chat', cost: { input: 0.27, output: 1.1 } },
    ])
  })

  test('accepts a pricing-only entry without a cost', () => {
    const out = normalizeCustomConfig({ ...base, models: [{ upstreamModelId: 'm' }] })
    expect(out.models).toEqual([{ upstreamModelId: 'm', cost: undefined }])
  })

  test('rejects an unknown billing dimension in cost', () => {
    expect(() => normalizeCustomConfig({
      ...base,
      models: [{ upstreamModelId: 'm', cost: { bogus: 1 } }],
    })).toThrow(/unknown cost dimension: bogus/)
  })

  test('rejects a negative price', () => {
    expect(() => normalizeCustomConfig({
      ...base,
      models: [{ upstreamModelId: 'm', cost: { input: -1 } }],
    })).toThrow(/must be a non-negative number/)
  })
})

describe('normalizeCustomConfig baseUrl validation', () => {
  const base = { name: 'ds', apiKey: 'sk-1' }

  test('rejects a non-URL baseUrl', () => {
    expect(() => normalizeCustomConfig({ ...base, baseUrl: 'api.deepseek.com' }))
      .toThrow(/baseUrl must be an absolute http\(s\) URL/)
  })

  test('rejects a non-http scheme', () => {
    expect(() => normalizeCustomConfig({ ...base, baseUrl: 'file:///etc/passwd' }))
      .toThrow(/baseUrl must use http: or https:/)
  })

  // new URL() silently collapses /v1/.. to /, so the request would leave the
  // operator's intended prefix without any error surfacing.
  test('rejects a traversal segment in baseUrl', () => {
    expect(() => normalizeCustomConfig({ ...base, baseUrl: 'https://api.x.com/v1/../..' }))
      .toThrow(/baseUrl must not contain/)
  })

  // A query string turns the appended path into part of the query value.
  test('rejects a query string in baseUrl', () => {
    expect(() => normalizeCustomConfig({ ...base, baseUrl: 'https://api.x.com/v1?k=1' }))
      .toThrow(/baseUrl must not contain a query string or fragment/)
  })

  test('rejects a fragment in baseUrl', () => {
    expect(() => normalizeCustomConfig({ ...base, baseUrl: 'https://api.x.com/v1#f' }))
      .toThrow(/baseUrl must not contain a query string or fragment/)
  })

  test('accepts a plain http baseUrl', () => {
    expect(normalizeCustomConfig({ ...base, baseUrl: 'http://localhost:8080/v1' }).baseUrl)
      .toBe('http://localhost:8080/v1')
  })
})

describe('normalizeCustomConfig modelsEndpoint validation', () => {
  const base = { name: 'ds', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-1' }

  test('accepts an absolute http(s) URL', () => {
    const out = normalizeCustomConfig({ ...base, modelsEndpoint: 'https://models.x.com/list' })
    expect(out.modelsEndpoint).toBe('https://models.x.com/list')
  })

  test('rejects a relative modelsEndpoint', () => {
    expect(() => normalizeCustomConfig({ ...base, modelsEndpoint: '/models' }))
      .toThrow(/modelsEndpoint must be an absolute http\(s\) URL/)
  })

  test('rejects a non-http scheme', () => {
    expect(() => normalizeCustomConfig({ ...base, modelsEndpoint: 'ftp://x/models' }))
      .toThrow(/modelsEndpoint must use http: or https:/)
  })

  test('leaves modelsEndpoint undefined when blank', () => {
    expect(normalizeCustomConfig({ ...base, modelsEndpoint: '  ' }).modelsEndpoint).toBeUndefined()
  })
})
