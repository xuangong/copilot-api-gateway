import { describe, test, expect } from 'bun:test'
import { CustomProvider } from '../provider.ts'

describe('CustomProvider constructor', () => {
  test('throws when apiKey is missing', () => {
    expect(() => new CustomProvider({
      name: 'x', baseUrl: 'https://api.example.com/v1', apiKey: '',
    })).toThrow(/apiKey/)
  })

  test('throws when baseUrl is missing', () => {
    expect(() => new CustomProvider({
      name: 'x', baseUrl: '', apiKey: 'sk-1',
    })).toThrow(/baseUrl/)
  })

  test('strips trailing slashes from baseUrl', () => {
    const p = new CustomProvider({
      name: 'x', baseUrl: 'https://api.example.com/v1///', apiKey: 'sk-1',
    })
    expect((p as unknown as { modelsEndpoint: string }).modelsEndpoint)
      .toBe('https://api.example.com/v1/models')
  })

  test('exposes kind/name/supportedEndpoints with chat_completions+embeddings defaults', () => {
    const p = new CustomProvider({
      name: 'deepseek-prod', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-1',
    })
    expect(p.kind).toBe('custom')
    expect(p.name).toBe('deepseek-prod')
    expect(p.supportedEndpoints).toEqual(['chat_completions', 'embeddings'])
  })

  test('respects custom endpoints override', () => {
    const p = new CustomProvider({
      name: 'x', baseUrl: 'https://x', apiKey: 'k',
      endpoints: ['responses', 'chat_completions'],
    })
    expect(p.supportedEndpoints).toEqual(['responses', 'chat_completions'])
  })

  test('respects modelsEndpoint override', () => {
    const p = new CustomProvider({
      name: 'x', baseUrl: 'https://x', apiKey: 'k',
      modelsEndpoint: 'https://elsewhere/list',
    })
    expect((p as unknown as { modelsEndpoint: string }).modelsEndpoint)
      .toBe('https://elsewhere/list')
  })

  test('coerces manual models (string + object form)', () => {
    const p = new CustomProvider({
      name: 'x', baseUrl: 'https://x', apiKey: 'k',
      models: ['m1', { id: 'm2', name: 'Two', ownedBy: 'acme' }],
    })
    const manual = (p as unknown as { manualModels: Array<{ id: string; name?: string; ownedBy?: string }> }).manualModels
    expect(manual).toEqual([
      { id: 'm1', name: undefined, ownedBy: undefined },
      { id: 'm2', name: 'Two', ownedBy: 'acme' },
    ])
  })
})
