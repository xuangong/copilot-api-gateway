import { expect, test } from "bun:test"
import { codexModelContextWindow, codexModelUsesResponsesLite, codexRawToProviderModel, fetchCodexCatalog } from "../models.ts"

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
  expect(model.providerData).toEqual({ useResponsesLite: value ?? false, contextWindow: 128000 })
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

// Adapted from reference copilot-gateway ed65eb148 (#567): a stale client
// identity omits newer models from the catalog and gets them rejected on
// /codex/responses, so the catalog request pins the current stable CLI.
test("catalog request pins the current stable Codex client identity", async () => {
  let url = ""
  let headers = new Headers()
  await fetchCodexCatalog({
    accessToken: "synthetic", accountId: "synthetic",
    fetcher: async (input, init) => {
      url = String(input)
      headers = new Headers(init?.headers)
      return Response.json({ models: [] })
    },
  })
  expect(url).toEndWith("/codex/models?client_version=0.159.3")
  expect(headers.get("user-agent")).toBe("codex_cli_rs/0.159.3 (Mac OS 26.5.0; arm64) iTerm.app/3.6.10")
})

// Adapted from reference copilot-gateway 040af9205 (#740): a new upstream input
// modality (audio, video, ...) must not make the whole catalog throw. Unknown
// ones are retained on the raw entry; chat modalities advertise only the ones
// the gateway understands (text, image, audio).
test("catalog keeps new input modalities without throwing or advertising unsupported input", async () => {
  const catalog = await fetchCodexCatalog({
    accessToken: "synthetic", accountId: "synthetic",
    fetcher: async () => Response.json({ models: [
      { slug: "x", display_name: "X", context_window: 1, input_modalities: ["text", "video", "image", "video", "audio"] },
      { slug: "old", display_name: "Old", context_window: 1, input_modalities: ["text"] },
      { slug: "audio", display_name: "Audio", context_window: 1, input_modalities: ["audio"] },
      { slug: "future", display_name: "Future", context_window: 1, input_modalities: ["video"] },
    ] }),
  })
  expect(catalog).toHaveLength(4)
  expect(catalog[0]?.input_modalities).toEqual(["text", "video", "image", "audio"])
  const models = catalog.map(raw => codexRawToProviderModel(raw))
  expect(models[0]?.chat?.modalities).toEqual({ input: ["text", "image", "audio"], output: ["text"] })
  expect(models[1]?.chat?.modalities).toEqual({ input: ["text"], output: ["text"] })
  expect(models[2]?.chat?.modalities).toEqual({ input: ["audio"], output: ["text"] })
  expect(models[3]?.chat?.modalities).toEqual({ input: [], output: ["text"] })
})

test.each([null, "text", [null], [1], [true], [{}], [""]].map(value => [value]))("catalog rejects malformed input_modalities %j", async value => {
  await expect(fetchCodexCatalog({
    accessToken: "synthetic", accountId: "synthetic",
    fetcher: async () => Response.json({ models: [{ slug: "x", display_name: "X", context_window: 1, input_modalities: value }] }),
  })).rejects.toThrow("input_modalities")
})

// Adapted from reference copilot-gateway 5a6c62963 (#559): the backend's default
// window and its override ceiling are different facts. Collapsing them makes
// clients compact at the ceiling (or lose long-context opt-in).
test("catalog keeps the default context window separate from the maximum ceiling", async () => {
  const [raw, plain] = await fetchCodexCatalog({
    accessToken: "synthetic", accountId: "synthetic",
    fetcher: async () => Response.json({ models: [
      { slug: "long", display_name: "Long", context_window: 272000, max_context_window: 1000000 },
      { slug: "plain", display_name: "Plain", context_window: 64000 },
    ] }),
  })
  if (!raw || !plain) throw new Error("Missing catalog model")
  const model = codexRawToProviderModel(raw)
  expect(model.limits.max_context_window_tokens).toBe(1000000)
  expect(codexModelContextWindow(model)).toEqual({ context_window: 272000, max_context_window: 1000000 })
  expect(codexModelContextWindow(codexRawToProviderModel(plain))).toEqual({ context_window: 64000, max_context_window: 64000 })
})
