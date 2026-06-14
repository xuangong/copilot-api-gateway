import { describe, expect, test } from 'bun:test'
import type { UpstreamRecord } from '@vnext/protocols/common'
import { CustomProvider } from '../src/provider'
import { customProviderPlugin } from '../src/plugin'

function makeUpstream(config: Record<string, unknown>): UpstreamRecord {
  return {
    id: 'u1',
    provider: 'custom',
    name: 'custom-test',
    enabled: true,
    sortOrder: 0,
    config,
    flagOverrides: {},
    disabledPublicModelIds: [],
    createdAt: '2026-06-14',
    updatedAt: '2026-06-14',
  }
}

describe('customProviderPlugin', () => {
  test('kind is custom', () => {
    expect(customProviderPlugin.kind).toBe('custom')
  })

  test('createFromUpstream returns CustomProvider from upstream.config', async () => {
    const upstream = makeUpstream({
      name: 'my-custom',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'test-key',
    })
    const provider = await customProviderPlugin.createFromUpstream(upstream, {})
    expect(provider).toBeInstanceOf(CustomProvider)
  })
})
