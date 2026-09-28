import { expect, test } from "bun:test"
import { normalizeCustomConfig } from "@vibe-llm/provider-custom"
import { formatModelsText, parseModelsText } from "../../../apps/dashboard/src/tabs/upstreams/model-text"

test("model editor roundtrip survives backend configuration validation", () => {
  const models = [{ id: "named", name: "Named", ownedBy: "vendor" }, { upstreamModelId: "named", cost: { input: 0.001, output: 0.002 } }]
  const normalized = normalizeCustomConfig({
    name: "fixture", baseUrl: "https://example.invalid", authStyle: "none",
    models: parseModelsText(formatModelsText(models)),
  })
  expect(normalized.models).toEqual(models)
})
