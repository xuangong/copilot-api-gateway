import { describe, expect, test } from 'bun:test'
import type { UpstreamRecord } from '@vibe-llm/protocols/common'
import { SdfProvider } from '../src/provider'
import { sdfProviderPlugin } from '../src/plugin'

function makeUpstream(config: Record<string, unknown>): UpstreamRecord {
  return {
    id: 'u1',
    provider: 'sdf',
    name: 'sdf-test',
    enabled: true,
    sortOrder: 0,
    config,
    flagOverrides: {},
    disabledPublicModelIds: [],
    createdAt: '2026-06-14',
    updatedAt: '2026-06-14',
  }
}

describe('sdfProviderPlugin', () => {
  test('kind is sdf', () => {
    expect(sdfProviderPlugin.kind).toBe('sdf')
  })

  test('createFromUpstream returns SdfProvider from upstream.config', async () => {
    const upstream = makeUpstream({
      name: 'sdf-images',
      substrateToken: 'substrate-bearer-token',
    })
    const provider = await sdfProviderPlugin.createFromUpstream(upstream, {})
    expect(provider).toBeInstanceOf(SdfProvider)
  })
})
