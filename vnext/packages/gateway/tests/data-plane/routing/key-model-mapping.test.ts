import { expect, test } from 'bun:test'
import {
  DEFAULT_API_KEY_MODEL_MAPPINGS,
  MAX_MODEL_MAPPINGS,
  MAX_MODEL_NAME_LENGTH,
  normalizeApiKeyModelMappings,
  parseStoredApiKeyModelMappings,
} from '../../../src/shared/api-key-model-mappings.ts'
import { resolveKeyModel } from '../../../src/data-plane/routing/key-model-mapping.ts'

const enabled = { modelMappingsEnabled: true, modelMappings: [] }

test('normalizer trims mappings while preserving duplicates and order', () => {
  const result = normalizeApiKeyModelMappings([
    { source: ' a ', destination: ' b ' },
    { source: 'a', destination: 'c' },
  ])

  expect(result).toEqual({
    ok: true,
    value: [
      { source: 'a', destination: 'b' },
      { source: 'a', destination: 'c' },
    ],
  })
})

test('normalizer accepts exactly the maximum mappings in order', () => {
  const mappings = Array.from({ length: MAX_MODEL_MAPPINGS }, (_, index) => ({
    source: ` source-${index} `,
    destination: ` destination-${index} `,
  }))

  expect(normalizeApiKeyModelMappings(mappings)).toEqual({
    ok: true,
    value: Array.from({ length: MAX_MODEL_MAPPINGS }, (_, index) => ({
      source: `source-${index}`,
      destination: `destination-${index}`,
    })),
  })
})

test('normalizer accepts model names at the maximum length', () => {
  const source = 's'.repeat(MAX_MODEL_NAME_LENGTH)
  const destination = 'd'.repeat(MAX_MODEL_NAME_LENGTH)

  expect(normalizeApiKeyModelMappings([{ source, destination }])).toEqual({
    ok: true,
    value: [{ source, destination }],
  })
})

test('normalizer fails the entire list closed without exposing invalid values', () => {
  const cases: Array<{ input: unknown; expected: object }> = [
    { input: {}, expected: { ok: false, reason: 'not_array' } },
    { input: [[]], expected: { ok: false, reason: 'invalid_item', index: 0 } },
    { input: [null], expected: { ok: false, reason: 'invalid_item', index: 0 } },
    { input: [42], expected: { ok: false, reason: 'invalid_item', index: 0 } },
    { input: [{ source: 1, destination: 'b' }], expected: { ok: false, reason: 'invalid_field', index: 0, field: 'source' } },
    { input: [{ source: 'a', destination: false }], expected: { ok: false, reason: 'invalid_field', index: 0, field: 'destination' } },
    { input: [{ source: 'a', destination: '   ' }], expected: { ok: false, reason: 'empty_field', index: 0, field: 'destination' } },
    { input: [{ source: ' ', destination: 'b' }], expected: { ok: false, reason: 'empty_field', index: 0, field: 'source' } },
    { input: [{ source: 'a', destination: 'b'.repeat(MAX_MODEL_NAME_LENGTH + 1) }], expected: { ok: false, reason: 'field_too_long', index: 0, field: 'destination' } },
    { input: Array.from({ length: MAX_MODEL_MAPPINGS + 1 }, () => ({ source: 'a', destination: 'b' })), expected: { ok: false, reason: 'too_many_items' } },
    { input: [{ source: 'a'.repeat(MAX_MODEL_NAME_LENGTH + 1), destination: 'b' }], expected: { ok: false, reason: 'field_too_long', index: 0, field: 'source' } },
  ]

  for (const { input, expected } of cases) {
    expect(normalizeApiKeyModelMappings(input)).toEqual(expected)
  }
})

test('stored mapping parser labels JSON parsing failures without exposing input', () => {
  expect(parseStoredApiKeyModelMappings('{')).toEqual({ ok: false, reason: 'invalid_json' })
})

test('default mappings and their elements cannot be mutated by consumers', () => {
  const defaults = DEFAULT_API_KEY_MODEL_MAPPINGS as Array<{ source: string; destination: string }>
  const defaultMapping = defaults[0]!

  expect(() => defaults.push({ source: 'x', destination: 'y' })).toThrow()
  expect(() => { defaultMapping.source = 'x' }).toThrow()
  expect(() => { defaultMapping.destination = 'y' }).toThrow()
  expect(DEFAULT_API_KEY_MODEL_MAPPINGS).toEqual([
    { source: 'gpt-5.6-sol', destination: 'gpt-5.6-sol-fast' },
  ])
})

test('resolver returns requests unchanged when disabled or no mapping matches', () => {
  const disabled = resolveKeyModel(' a ', { modelMappingsEnabled: false, modelMappings: [{ source: 'a', destination: 'b' }] })
  const empty = resolveKeyModel('a', enabled)
  const unmatched = resolveKeyModel('a', { modelMappingsEnabled: true, modelMappings: [{ source: 'b', destination: 'c' }] })

  expect(disabled).toEqual({ requestedModel: ' a ', routedModel: ' a ', matchedRuleIndexes: [] })
  expect(empty).toEqual({ requestedModel: 'a', routedModel: 'a', matchedRuleIndexes: [] })
  expect(unmatched).toEqual({ requestedModel: 'a', routedModel: 'a', matchedRuleIndexes: [] })
})

test('resolver applies defaults and ordered chains exactly once per mapping', () => {
  expect(resolveKeyModel('gpt-5.6-sol', {
    modelMappingsEnabled: true,
    modelMappings: DEFAULT_API_KEY_MODEL_MAPPINGS,
  })).toEqual({
    requestedModel: 'gpt-5.6-sol',
    routedModel: 'gpt-5.6-sol-fast',
    matchedRuleIndexes: [0],
  })

  expect(resolveKeyModel('a', {
    modelMappingsEnabled: true,
    modelMappings: [
      { source: 'a', destination: 'b' },
      { source: 'b', destination: 'a' },
      { source: 'a', destination: 'c' },
    ],
  })).toEqual({ requestedModel: 'a', routedModel: 'c', matchedRuleIndexes: [0, 1, 2] })
})

test('resolver preserves duplicate mappings and self mappings', () => {
  expect(resolveKeyModel('a', {
    modelMappingsEnabled: true,
    modelMappings: [
      { source: 'a', destination: 'a' },
      { source: 'a', destination: 'b' },
      { source: 'b', destination: 'b' },
    ],
  })).toEqual({ requestedModel: 'a', routedModel: 'b', matchedRuleIndexes: [0, 1, 2] })
})

test('resolver preserves valid upstream pins and does not mistake vendors for pins', () => {
  const policy = { modelMappingsEnabled: true, modelMappings: [{ source: 'a', destination: 'b' }] }
  expect(resolveKeyModel('up_123/a', policy)).toEqual({
    requestedModel: 'up_123/a',
    routedModel: 'up_123/b',
    upstreamPin: 'up_123',
    matchedRuleIndexes: [0],
  })
  expect(resolveKeyModel('vendor/a', policy)).toEqual({
    requestedModel: 'vendor/a',
    routedModel: 'vendor/a',
    matchedRuleIndexes: [],
  })
})

test('resolver does not mutate its input or mapping list', () => {
  const mappings = [{ source: 'a', destination: 'b' }]
  const policy = { modelMappingsEnabled: true, modelMappings: mappings }
  const requested = 'up_123/a'

  resolveKeyModel(requested, policy)

  expect(requested).toBe('up_123/a')
  expect(policy).toEqual({ modelMappingsEnabled: true, modelMappings: [{ source: 'a', destination: 'b' }] })
  expect(mappings).toEqual([{ source: 'a', destination: 'b' }])
})
