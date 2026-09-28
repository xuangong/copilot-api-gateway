import { expect, test } from 'bun:test'
import { responsesFormatGuard } from './responses-format-guard'

test('format guard compares key order independently and snapshots before mutations', () => {
  const body = { response_format: { type: 'json_schema', json_schema: { name: 'a', schema: { type: 'object', required: ['a', 'b'] }, strict: true } } }
  const guard = responsesFormatGuard('responses', 'chat_completions', body)
  expect(guard({ response_format: { json_schema: { strict: true, schema: { required: ['a', 'b'], type: 'object' }, name: 'a' }, type: 'json_schema' } })).toBe(true)
  body.response_format.json_schema.strict = false
  expect(guard(body)).toBe(false)
  expect(guard({})).toBe(false)
})
test('native protocol normalizers and ordinary text keep existing behavior', () => {
  for (const source of ['messages', 'chat_completions', undefined]) expect(responsesFormatGuard(source, 'messages', { output_config: { format: {} } })({})).toBe(true)
  expect(responsesFormatGuard('responses', 'responses', { text: { format: {} } })({})).toBe(true)
  expect(responsesFormatGuard('responses', 'chat_completions', {})({})).toBe(true)
})
