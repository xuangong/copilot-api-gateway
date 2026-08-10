import { test, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { BunSqliteRepo as SqliteRepo } from '@vibe-llm/platform-bun/src/bun-sqlite-repo.ts'
import type { SearchConfig } from '../../src/repo/types.ts'

function freshRepo(): SqliteRepo {
  return new SqliteRepo(new Database(':memory:'))
}

const sampleConfig = (): SearchConfig => ({
  provider: 'tavily',
  tavily: { apiKey: 'tv-xxx' },
  microsoftGrounding: { apiKey: 'ms-yyy' },
  jina: { apiKey: 'jn-zzz' },
  bing: { apiKey: '' },
  copilot: { githubToken: 'gho_abc' },
  langsearch: { apiKey: 'ls-key' },
  passthroughOpenAiSearch: {
    enabled: true,
    upstreamId: 'up_abc',
    model: 'gpt-4o-search-preview',
  },
})

test('get() returns null when no row saved', async () => {
  const repo = freshRepo()
  const cfg = await repo.searchConfig.get()
  expect(cfg).toBeNull()
})

test('save() then get() round-trips all fields', async () => {
  const repo = freshRepo()
  const cfg = sampleConfig()
  await repo.searchConfig.save(cfg)

  const loaded = await repo.searchConfig.get()
  expect(loaded).toEqual(cfg)
})

test('save() overwrites the singleton row', async () => {
  const repo = freshRepo()
  await repo.searchConfig.save(sampleConfig())

  const next: SearchConfig = {
    provider: 'disabled',
    tavily: { apiKey: '' },
    microsoftGrounding: { apiKey: '' },
    jina: { apiKey: 'jn-new' },
    bing: { apiKey: '' },
    copilot: { githubToken: '' },
    langsearch: { apiKey: '' },
    passthroughOpenAiSearch: { enabled: false, upstreamId: '', model: '' },
  }
  await repo.searchConfig.save(next)

  const loaded = await repo.searchConfig.get()
  expect(loaded).toEqual(next)
})

test('passthrough enabled=false stored as 0 and restored correctly', async () => {
  const repo = freshRepo()
  const cfg: SearchConfig = {
    provider: 'jina',
    tavily: { apiKey: '' },
    microsoftGrounding: { apiKey: '' },
    jina: { apiKey: 'jn-only' },
    bing: { apiKey: '' },
    copilot: { githubToken: '' },
    langsearch: { apiKey: '' },
    passthroughOpenAiSearch: { enabled: false, upstreamId: '', model: '' },
  }
  await repo.searchConfig.save(cfg)

  const loaded = await repo.searchConfig.get()
  expect(loaded?.passthroughOpenAiSearch.enabled).toBe(false)
})
