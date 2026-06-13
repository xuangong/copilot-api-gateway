import { test, expect } from 'bun:test'
import { CopilotProvider } from '../provider.ts'

test('CopilotProvider.getPricingForModelKey delegates to pricingForCopilotModelKey', () => {
  const p = new CopilotProvider({ copilotToken: 'tok', accountType: 'individual' })
  expect(p.getPricingForModelKey('claude-opus-4-7')).toEqual({
    input: 5, input_cache_read: 0.5, input_cache_write: 6.25, output: 25,
  })
  expect(p.getPricingForModelKey('unknown')).toBeNull()
})
