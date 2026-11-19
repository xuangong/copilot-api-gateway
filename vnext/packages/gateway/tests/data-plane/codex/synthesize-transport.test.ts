import { expect, test } from "bun:test"
import { synthesizeCatalogEntry } from "../../../src/data-plane/codex/synthesize.ts"

test("Codex catalog never advertises unavailable gateway WebSockets", () => {
  const baseline = synthesizeCatalogEntry({ id: "custom-model" })
  expect(baseline.prefer_websockets).toBe(false)
  for (const preference of [true, false]) {
    const model = synthesizeCatalogEntry({ id: "alias" }, { ...baseline, prefer_websockets: preference })
    expect(model.prefer_websockets).toBe(false)
    expect(model.slug).toBe("alias")
  }
})

test("Codex catalog advertises installed Responses ingress even when source prefers HTTP", () => {
  const source = { slug: "gpt-5", prefer_websockets: false }
  expect(synthesizeCatalogEntry({ id: "alias" }, source, {}, true).prefer_websockets).toBe(true)
  expect(synthesizeCatalogEntry({ id: "unmatched" }, undefined, {}, true).prefer_websockets).toBe(true)
})

test.each([true, false, undefined])("Codex catalog uses the selected upstream image detail fact %s", (supported) => {
  const source = { slug: "gpt-5", supports_image_detail_original: true, input_modalities: ["text", "image"] }
  const row = { id: "alias", chat: supported === undefined ? undefined : { image_detail_original: supported, modalities: { input: ["text", "image"] } } }
  expect(synthesizeCatalogEntry(row, source).supports_image_detail_original).toBe(supported === true)
})

// Adapted from reference copilot-gateway 5a6c62963 (#559): a Codex provider's
// private default window rides separately from its published maximum, so
// clients can opt into long contexts without changing the compaction default.
test("Codex row keeps default context_window separate from max_context_window", () => {
  const row = { id: "gpt-long", limits: { max_context_window_tokens: 1000000 }, providerData: { contextWindow: 272000, useResponsesLite: false } }
  const entry = synthesizeCatalogEntry(row, { slug: "gpt-long", context_window: 128000, max_context_window: 128000 })
  expect(entry.context_window).toBe(272000)
  expect(entry.max_context_window).toBe(1000000)
})

// Reference 5a6c62963: other providers use their input cap for both windows and
// never exceed a smaller context cap.
test.each([
  [{ max_context_window_tokens: 1000000, max_prompt_tokens: 936000 }, 936000],
  [{ max_prompt_tokens: 936000 }, 936000],
  [{ max_context_window_tokens: 100000, max_prompt_tokens: 120000 }, 100000],
])("non-Codex row uses the provider input cap for both windows %j", (limits, expected) => {
  const entry = synthesizeCatalogEntry({ id: "m", capabilities: { limits } })
  expect(entry.context_window).toBe(expected)
  expect(entry.max_context_window).toBe(expected)
})

// Adapted from reference copilot-gateway 2045cd7ec (#577): Codex resolves Ultra
// through `multi_agent_reasoning_effort`, so it must name the last supported
// non-Ultra effort (including vendor-specific values), not a stale catalog one.
test.each(["v1", "v2"])("maps an existing Ultra preset to the last non-Ultra effort, keeping multi-agent %s", version => {
  const levels = ["xhigh", "max", "ultra"].map(effort => ({ effort, description: effort }))
  const entry = synthesizeCatalogEntry({ id: "m" }, {
    slug: "m", supported_reasoning_levels: levels, multi_agent_version: version, multi_agent_reasoning_effort: "xhigh",
  })
  expect(entry.multi_agent_reasoning_effort).toBe("max")
  expect(entry.multi_agent_version).toBe(version)
  expect(entry.supported_reasoning_levels).toEqual(levels)
})

test.each([
  { efforts: ["max", "high", "ultra"], expected: "high" },
  { efforts: ["high", "ultra", "vendor-specific"], expected: "vendor-specific" },
  { efforts: ["vendor-specific", "ultra"], expected: "vendor-specific" },
  { efforts: ["ultra", "none"], expected: "none" },
])("maps Ultra to the last non-Ultra effort in $efforts", ({ efforts, expected }) => {
  const levels = efforts.map(effort => ({ effort, description: effort }))
  const entry = synthesizeCatalogEntry({ id: "m" }, { slug: "m", supported_reasoning_levels: levels, multi_agent_version: "v2" })
  expect(entry.multi_agent_reasoning_effort).toBe(expected)
  expect(entry.supported_reasoning_levels).toEqual(levels)
  expect(entry.multi_agent_version).toBe("v2")
})

test.each([
  { efforts: ["xhigh", "max"], mapping: "xhigh" },
  { efforts: [], mapping: "xhigh" },
  { efforts: ["ultra"], mapping: undefined },
  { efforts: ["ultra"], mapping: "xhigh" },
])("preserves the catalog mapping without Ultra or a non-Ultra effort: $efforts", ({ efforts, mapping }) => {
  const levels = efforts.map(effort => ({ effort, description: "" }))
  const entry = synthesizeCatalogEntry({ id: "m" }, { slug: "m", supported_reasoning_levels: levels, multi_agent_reasoning_effort: mapping })
  expect(entry.multi_agent_reasoning_effort).toBe(mapping)
})

test("an Ultra level added from client capabilities maps to Max", () => {
  const entry = synthesizeCatalogEntry({ id: "m" }, {
    slug: "m", supported_reasoning_levels: [{ effort: "high", description: "" }, { effort: "max", description: "" }],
  }, { ultraReasoningLevel: { effort: "ultra", description: "Ultra" } })
  expect(entry.multi_agent_version).toBe("v2")
  expect(entry.multi_agent_reasoning_effort).toBe("max")
})

test("Codex does not advertise original image detail for a text-only upstream", () => {
  const entry = synthesizeCatalogEntry({ id: "text-only", chat: {
    image_detail_original: true, modalities: { input: ["text"] },
  } }, { slug: "gpt-5", input_modalities: ["text", "image"], supports_image_detail_original: true })
  expect(entry.input_modalities).toEqual(["text"])
  expect(entry.supports_image_detail_original).toBe(false)
})
