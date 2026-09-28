import { describe, expect, test } from 'bun:test'
import type { ResponsesPayload } from '@vibe-llm/protocols/responses'
import { translateResponsesToChat } from '../src/responses-via-chat-completions/request'
import { translateResponsesToMessages } from '../src/responses-via-messages/request'
import { TranslatorValidationError } from '../src/errors'

const schema = { type: 'object', properties: { answer: { type: 'string' } } }
const format = { type: 'json_schema', name: 'answer', schema, strict: true }
const payload = (extra: Record<string, unknown>): ResponsesPayload => ({ model: 'model', input: 'JSON please', ...extra }) as ResponsesPayload
for (const [name, translate] of [['chat', translateResponsesToChat], ['messages', translateResponsesToMessages]] as const) {
  describe(name, () => {
    test('preserves source and projects a supported schema', () => {
      const source = payload({ text: { format } })
      const before = structuredClone(source)
      const result = translate(source).target as Record<string, unknown>
      expect(source).toEqual(before)
      expect(name === 'chat' ? result.response_format : result.output_config).toEqual(name === 'chat'
        ? { type: 'json_schema', json_schema: { name: 'answer', schema, strict: true } }
        : { format: { type: 'json_schema', schema } })
    })
    for (const [extra, field] of [
      [{ text: null }, 'text'], [{ text: [] }, 'text'],
      [{ text: { format: null } }, 'text.format'],
      [{ text: { format: {} } }, 'text.format.type'],
      [{ text: { format: { type: 'xml' } } }, 'text.format.type'],
      [{ text: { format: { type: 'text', schema } } }, 'text.format.schema'],
      [{ text: { format: { ...format, name: '' } } }, 'text.format.name'],
      [{ text: { format: { ...format, schema: [] } } }, 'text.format.schema'],
      [{ text: { format: { ...format, strict: null } } }, 'text.format.strict'],
      [{ text: { format: { ...format, description: 1 } } }, 'text.format.description'],
      [{ text: { format: { ...format, json_schema: {} } } }, 'text.format.json_schema'],
    ] as const) {
      test(`rejects malformed ${field}: ${JSON.stringify(extra)}`, () => {
        try { translate(payload(extra)); throw new Error('accepted malformed format') }
        catch (error) { expect(error).toBeInstanceOf(TranslatorValidationError); expect((error as TranslatorValidationError).field).toBe(field) }
      })
    }
  })
}
test('Chat preserves optional false strict and empty description', () => {
  const result = translateResponsesToChat(payload({ text: { format: { ...format, strict: false, description: '' } } })).target
  expect(result.response_format).toEqual({ type: 'json_schema', json_schema: { name: 'answer', schema, strict: false, description: '' } })
})
test('Messages preserves output_config siblings and reasoning effort', () => {
  const result = translateResponsesToMessages(payload({ text: { format }, reasoning: { effort: 'high' }, output_config: { extra: 'retained' } })).target
  expect(result.output_config).toEqual({ extra: 'retained', effort: 'high', format: { type: 'json_schema', schema } })
})
test('Messages rejects unsupported constraints', () => {
  for (const bad of [{ type: 'json_object' }, { ...format, strict: false }, { ...format, strict: undefined }, { ...format, description: '' }]) {
    expect(() => translateResponsesToMessages(payload({ text: { format: bad } }))).toThrow(TranslatorValidationError)
  }
})
test('native extension conflicts are explicit', () => {
  expect(() => translateResponsesToChat(payload({ text: { format }, response_format: { type: 'json_object' } }))).toThrow(TranslatorValidationError)
  expect(() => translateResponsesToMessages(payload({ text: { format }, output_config: { format: { type: 'json_schema', schema: {} } } }))).toThrow(TranslatorValidationError)
})
test('format type must be a string, not a coercible value', () => {
  for (const type of [['text'], ['json_schema'], { type: 'text' }]) {
    expect(() => translateResponsesToChat(payload({ text: { format: { type } } }))).toThrow(TranslatorValidationError)
  }
})
test('equivalent target extension accepts reordered schema keys without aliasing', () => {
  const source = payload({ text: { format }, response_format: { json_schema: { schema, strict: true, name: 'answer' }, type: 'json_schema' } })
  const target = translateResponsesToChat(source).target as Record<string, unknown>
  expect(target.response_format).toEqual(source.response_format)
  const projected = target.response_format as { json_schema: { schema: Record<string, unknown> } }
  projected.json_schema.schema.changed = true
  expect(schema).not.toHaveProperty('changed')
})
