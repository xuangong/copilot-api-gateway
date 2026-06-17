import { test, expect } from 'bun:test'
import { TranslatorValidationError } from '../src/errors.ts'

test('TranslatorValidationError carries kind tag and field', () => {
  const e = new TranslatorValidationError('bad payload', 'messages[0].content')
  expect(e).toBeInstanceOf(Error)
  expect(e.name).toBe('TranslatorValidationError')
  expect(e.kind).toBe('translator-validation')
  expect(e.field).toBe('messages[0].content')
})

test('TranslatorValidationError detectable via instanceof', async () => {
  const mod = await import('../src/errors.ts')
  const e = new mod.TranslatorValidationError('x')
  expect(e instanceof TranslatorValidationError).toBe(true)
})
