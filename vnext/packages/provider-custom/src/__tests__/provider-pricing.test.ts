import { test, expect } from 'bun:test'
import { CustomProvider } from '../provider.ts'

const baseCfg = {
  name: 'custom-test',
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'k',
  endpoints: ['chat_completions'] as const,
}

test('CustomProvider: manual config.models[].cost wins', () => {
  const p = new CustomProvider({
    ...baseCfg,
    models: [{ upstreamModelId: 'deepseek-chat', cost: { input: 0.27, output: 1.1 } }],
  })
  expect(p.getPricingForModelKey('deepseek-chat')).toEqual({ input: 0.27, output: 1.1 })
})

test('CustomProvider: returns null when no manual + no fetched pricing', () => {
  const p = new CustomProvider(baseCfg)
  expect(p.getPricingForModelKey('whatever')).toBeNull()
})
