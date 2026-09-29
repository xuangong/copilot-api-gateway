import { expect, test } from "bun:test"
import { assembleCodexCatalog } from "../../../src/data-plane/codex/models.ts"

test.each(["coding", "gpt-alternate"])("Codex alias %s inherits its destination's capabilities and retains its request id", (alias) => {
  const rows = [{ id: alias, name: alias, _mapped_to: "gpt-target" }]
  const catalog = assembleCodexCatalog({ models: [
    {
      slug: "gpt-target", input_modalities: ["text", "image"], support_verbosity: true,
      supported_reasoning_levels: [{ effort: "high", description: "High" }],
      default_reasoning_level: "high", context_window: 256000,
      service_tiers: ["default", "fast"], base_instructions: "Target instructions",
    },
    { slug: "gpt-alternate", input_modalities: ["text"], supported_reasoning_levels: [] },
  ] }, rows)

  expect(catalog.models).toEqual([expect.objectContaining({
    slug: alias, display_name: alias, input_modalities: ["text", "image"], support_verbosity: true,
    supported_reasoning_levels: [{ effort: "high", description: "High" }],
    default_reasoning_level: "high", context_window: 256000,
    service_tiers: [], base_instructions: "Target instructions",
  })])
})

test.each([true, false, undefined])("Codex alias carries the selected upstream image detail fact %s", (supported) => {
  const target = { id: "gpt-target", chat: {
    modalities: { input: ["text", "image"] as const },
    ...(supported === undefined ? {} : { image_detail_original: supported }),
  } }
  const alias = { ...target, id: "coding", _mapped_to: "gpt-target" }
  const output = assembleCodexCatalog({ models: [{
    slug: "gpt-target", input_modalities: ["text", "image"], supports_image_detail_original: true,
  }] }, [alias])
  expect(output.models[0]?.supports_image_detail_original).toBe(supported === true)
})

test("matched and unmatched Codex rows derive WebSocket preference from the current ingress", () => {
  const source = { models: [{ slug: "gpt-target", prefer_websockets: true }] }
  const rows = [{ id: "gpt-target" }, { id: "unmatched" }]
  expect(assembleCodexCatalog(source, rows).models.map(model => model.prefer_websockets)).toEqual([false, false])
  expect(assembleCodexCatalog(source, rows, {}, true).models.map(model => model.prefer_websockets)).toEqual([true, true])
})
