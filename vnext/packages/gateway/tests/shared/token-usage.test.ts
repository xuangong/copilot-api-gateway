import { test, expect } from 'bun:test'
import { recordTokenUsage, tokenUsageFromImagesBody } from '../../src/shared/token-usage.ts'
import type { Repo, UsageRecord } from '../../src/shared/repo/types.ts'

test('tokenUsageFromImagesBody returns null for non-usage bodies', () => {
  expect(tokenUsageFromImagesBody(null)).toBeNull()
  expect(tokenUsageFromImagesBody('nope')).toBeNull()
  expect(tokenUsageFromImagesBody({})).toBeNull()
  expect(tokenUsageFromImagesBody({ usage: null })).toBeNull()
  expect(tokenUsageFromImagesBody({ usage: {} })).toBeNull()
})

test('tokenUsageFromImagesBody charges totals to bare metrics when details are absent', () => {
  expect(tokenUsageFromImagesBody({ usage: { input_tokens: 10, output_tokens: 3 } })).toEqual({
    input: 10,
    output: 3,
  })
})

test('tokenUsageFromImagesBody splits input/output by details.text/image_tokens', () => {
  expect(
    tokenUsageFromImagesBody({
      usage: {
        input_tokens: 12,
        output_tokens: 20,
        input_tokens_details: { text_tokens: 4, image_tokens: 8 },
        output_tokens_details: { text_tokens: 0, image_tokens: 20 },
      },
    }),
  ).toEqual({ input: 4, input_image: 8, output_image: 20 })
})

test('tokenUsageFromImagesBody rejects non-number totals and non-number split fields', () => {
  expect(tokenUsageFromImagesBody({ usage: { input_tokens: '5' } })).toBeNull()
  expect(
    tokenUsageFromImagesBody({
      usage: { input_tokens: 5, input_tokens_details: { text_tokens: '4' } },
    }),
  ).toBeNull()
})

test('tokenUsageFromImagesBody drops present-but-empty details objects to the bare metric', () => {
  expect(
    tokenUsageFromImagesBody({
      usage: { input_tokens: 7, input_tokens_details: {} },
    }),
  ).toEqual({ input: 7 })
})

const makeRepo = (): { repo: Repo; recorded: UsageRecord[] } => {
  const recorded: UsageRecord[] = []
  const repo = {
    usage: {
      record: async (r: UsageRecord) => { recorded.push(r) },
    },
  } as unknown as Repo
  return { repo, recorded }
}

test('recordTokenUsage no-ops when usage is null or all zeros', async () => {
  const { repo, recorded } = makeRepo()
  await recordTokenUsage('k1', { model: 'm', upstream: 'u', modelKey: 'mk', cost: null }, null, repo)
  await recordTokenUsage('k1', { model: 'm', upstream: 'u', modelKey: 'mk', cost: null }, { input: 0, output: 0 }, repo)
  expect(recorded).toEqual([])
})

test('recordTokenUsage writes a single row carrying the frozen pricing snapshot', async () => {
  const { repo, recorded } = makeRepo()
  await recordTokenUsage(
    'key-1',
    { model: 'gpt-image-2', upstream: 'copilot:acct', modelKey: 'gpt-image-2', cost: { input: 5, output_image: 40 } },
    { input: 12, output_image: 3 },
    repo,
  )
  expect(recorded).toHaveLength(1)
  const row = recorded[0]
  expect(row.keyId).toBe('key-1')
  expect(row.model).toBe('gpt-image-2')
  expect(row.upstream).toBe('copilot:acct')
  expect(row.modelKey).toBe('gpt-image-2')
  expect(row.client).toBe('')
  expect(row.requests).toBe(1)
  expect(row.tokens).toEqual({ input: 12, output_image: 3 })
  expect(row.cost).toEqual({ input: 5, output_image: 40 })
  expect(row.hour).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}$/)
})
