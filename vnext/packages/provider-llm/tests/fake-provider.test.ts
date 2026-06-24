import { test, expect } from 'bun:test'
import { FakeProvider } from '../src/fake.ts'

test('FakeProvider.getPricingForModelKey returns null by default', () => {
  const p = new FakeProvider({ text: 'test response' })
  expect(p.getPricingForModelKey('any-model')).toBeNull()
})
