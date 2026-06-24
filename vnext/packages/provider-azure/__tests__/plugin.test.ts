import { describe, expect, test } from 'bun:test'
import type { UpstreamRecord } from '@vnext-llm/protocols/common'
import { AzureProvider } from '../src/provider'
import { azureProviderPlugin } from '../src/plugin'

function makeUpstream(config: Record<string, unknown>): UpstreamRecord {
  return {
    id: 'u1',
    provider: 'azure',
    name: 'azure-test',
    enabled: true,
    sortOrder: 0,
    config,
    flagOverrides: {},
    disabledPublicModelIds: [],
    createdAt: '2026-06-14',
    updatedAt: '2026-06-14',
  }
}

describe('azureProviderPlugin', () => {
  test('kind is azure', () => {
    expect(azureProviderPlugin.kind).toBe('azure')
  })

  test('createFromUpstream returns AzureProvider from upstream.config', async () => {
    const upstream = makeUpstream({
      name: 'az',
      endpoint: 'https://example.openai.azure.com',
      apiKey: 'key',
      deployment: 'gpt-4o',
      apiVersion: '2024-08-01-preview',
      endpoints: ['chat_completions'],
    })
    const provider = await azureProviderPlugin.createFromUpstream(upstream, {})
    expect(provider).toBeInstanceOf(AzureProvider)
  })
})
