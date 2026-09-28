import { expect, test } from 'bun:test'
import { codexRawToProviderModel, fetchCodexCatalog } from '../models.ts'

test.each([true, false, undefined])('Codex discovery carries original image detail %s', async (supported) => {
  const raw = { slug: 'gpt-5', display_name: 'GPT 5', context_window: 128000,
    ...(supported === undefined ? {} : { supports_image_detail_original: supported }) }
  const rows = await fetchCodexCatalog({ accessToken: 'token', accountId: 'account',
    fetcher: async () => Response.json({ models: [raw] }) })
  expect(codexRawToProviderModel(rows[0]!).chat?.image_detail_original).toBe(supported ?? false)
})

test('Codex discovery rejects malformed original image detail', async () => {
  await expect(fetchCodexCatalog({ accessToken: 'token', accountId: 'account',
    fetcher: async () => Response.json({ models: [{ slug: 'gpt-5', display_name: 'GPT 5', context_window: 128000, supports_image_detail_original: 'yes' }] }) }))
    .rejects.toThrow(/supports_image_detail_original/)
})
