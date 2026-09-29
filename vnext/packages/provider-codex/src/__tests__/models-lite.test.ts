import { expect, test } from "bun:test"
import { codexModelUsesResponsesLite, codexRawToProviderModel, fetchCodexCatalog } from "../models.ts"

const discover = (use_responses_lite: unknown) => fetchCodexCatalog({
  accessToken: "synthetic", accountId: "synthetic",
  fetcher: async () => Response.json({ models: [{ slug: "model", display_name: "Model", context_window: 128000,
    use_responses_lite, supports_image_detail_original: true }] }),
})

test.each([true, false, undefined])("catalog carries strict Lite selection %s", async value => {
  const [raw] = await discover(value)
  if (!raw) throw new Error("Missing catalog model")
  const model = codexRawToProviderModel(raw)
  expect(raw.use_responses_lite).toBe(value)
  expect(model.providerData).toEqual({ useResponsesLite: value ?? false })
  expect(codexModelUsesResponsesLite(model)).toBe(value ?? false)
  expect(model.chat?.image_detail_original).toBe(true)
  expect(model.endpoints).toEqual({ responses: {} })
})

test.each([null, 0, 1, "true", [], {}].map(value => [value]))("catalog rejects malformed Lite flag %j", async value => {
  await expect(discover(value)).rejects.toThrow("use_responses_lite")
})

test.each([undefined, {}, { useResponsesLite: undefined }, { useResponsesLite: false }, { useResponsesLite: true }])(
  "provider selection uses strict metadata %j", providerData => {
    expect(codexModelUsesResponsesLite({ id: "model", providerData })).toBe(providerData?.useResponsesLite === true)
  },
)
test.each([null, [], "true", { useResponsesLite: null }, { useResponsesLite: 1 }, { useResponsesLite: "false" }].map(value => [value]))(
  "provider rejects malformed selection metadata %j", providerData => {
    expect(() => codexModelUsesResponsesLite({ id: "model", providerData })).toThrow("providerData")
  },
)
