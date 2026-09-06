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
    service_tiers: ["default", "fast"], base_instructions: "Target instructions",
  })])
})
