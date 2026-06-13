import { test, expect } from 'bun:test'
import { AzureProvider } from '../provider.ts'

const baseCfg = {
  name: 'azure-test',
  endpoint: 'https://example.openai.azure.com',
  apiKey: 'k',
  deployment: 'gpt-4o-deploy',
  apiVersion: '2024-08-01-preview',
  endpoints: ['chat_completions'] as const,
}

test('AzureProvider.getPricingForModelKey reads from config.models', () => {
  const p = new AzureProvider({
    ...baseCfg,
    models: [{ upstreamModelId: 'gpt-4o', cost: { input: 2.5, input_cache_read: 1.25, output: 10 } }],
  })
  expect(p.getPricingForModelKey('gpt-4o')).toEqual({ input: 2.5, input_cache_read: 1.25, output: 10 })
})

test('AzureProvider returns null for models without configured pricing', () => {
  const p = new AzureProvider(baseCfg)
  expect(p.getPricingForModelKey('gpt-4o')).toBeNull()
})
