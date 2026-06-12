import { describe, test, expect } from 'bun:test'
import { AzureProvider } from '../provider.ts'

describe('AzureProvider constructor', () => {
  const okCfg = {
    name: 'azure-eastus2',
    endpoint: 'https://my-aoai.openai.azure.com',
    apiKey: 'az-key',
    deployment: 'gpt-4o',
    apiVersion: '2024-08-01-preview',
    endpoints: ['chat_completions'] as const,
  }

  test('throws when apiKey is missing', () => {
    expect(() => new AzureProvider({ ...okCfg, apiKey: '' })).toThrow(/apiKey/)
  })

  test('throws when endpoint is missing', () => {
    expect(() => new AzureProvider({ ...okCfg, endpoint: '' })).toThrow(/endpoint/)
  })

  test('throws when deployment is missing', () => {
    expect(() => new AzureProvider({ ...okCfg, deployment: '' })).toThrow(/deployment/)
  })

  test('throws when apiVersion is missing', () => {
    expect(() => new AzureProvider({ ...okCfg, apiVersion: '' })).toThrow(/apiVersion/)
  })

  test('strips trailing slashes from endpoint', () => {
    const p = new AzureProvider({ ...okCfg, endpoint: 'https://my-aoai.openai.azure.com///' })
    expect((p as unknown as { endpoint: string }).endpoint)
      .toBe('https://my-aoai.openai.azure.com')
  })

  test('exposes kind/name/supportedEndpoints', () => {
    const p = new AzureProvider({ ...okCfg, endpoints: ['chat_completions', 'embeddings'] })
    expect(p.kind).toBe('azure')
    expect(p.name).toBe('azure-eastus2')
    expect(p.supportedEndpoints).toEqual(['chat_completions', 'embeddings'])
  })

  test('extraDeployments defaults to empty array', () => {
    const p = new AzureProvider(okCfg)
    const x = (p as unknown as { extraDeployments: ReadonlyArray<unknown> }).extraDeployments
    expect(x).toEqual([])
  })

  test('extraDeployments preserves provided list', () => {
    const deployments = [
      { name: 'gpt-4o-mini', model: 'gpt-4o-mini' },
      { name: 'o1-preview-dep', model: 'o1-preview' },
    ]
    const p = new AzureProvider({ ...okCfg, deployments })
    const x = (p as unknown as { extraDeployments: ReadonlyArray<{ name: string; model: string }> }).extraDeployments
    expect(x).toEqual(deployments)
  })
})

describe('AzureProvider.getModels', () => {
  const okCfg = {
    name: 'azure-eastus2',
    endpoint: 'https://my-aoai.openai.azure.com',
    apiKey: 'az-key',
    deployment: 'gpt-4o',
    apiVersion: '2024-08-01-preview',
    endpoints: ['chat_completions'] as const,
  }

  test('returns default deployment only when no extras', async () => {
    const p = new AzureProvider(okCfg)
    const res = await p.getModels() as { object: string; data: Array<{ id: string; owned_by: string }> }
    expect(res.object).toBe('list')
    expect(res.data).toHaveLength(1)
    expect(res.data[0]!.id).toBe('gpt-4o')
    expect(res.data[0]!.owned_by).toBe('azure')
  })

  test('combines default + extras and dedupes by model id', async () => {
    const p = new AzureProvider({
      ...okCfg,
      deployments: [
        { name: 'gpt-4o-mini-dep', model: 'gpt-4o-mini' },
        { name: 'gpt-4o-alt', model: 'gpt-4o' },
        { name: 'o1-preview-dep', model: 'o1-preview' },
      ],
    })
    const res = await p.getModels() as { data: Array<{ id: string }> }
    expect(res.data.map((m) => m.id)).toEqual(['gpt-4o', 'gpt-4o-mini', 'o1-preview'])
  })

  test('skips deployments with empty model field', async () => {
    const p = new AzureProvider({
      ...okCfg,
      deployments: [
        { name: 'unset-dep', model: '' },
        { name: 'ok-dep', model: 'gpt-35-turbo' },
      ],
    })
    const res = await p.getModels() as { data: Array<{ id: string }> }
    expect(res.data.map((m) => m.id)).toEqual(['gpt-4o', 'gpt-35-turbo'])
  })
})
