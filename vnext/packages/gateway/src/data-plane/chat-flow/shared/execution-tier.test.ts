import { expect, test } from "bun:test"
import { selectedTierBody, selectedTierEvent, selectedTierRequest } from "./execution-tier"
import { synthesizeCatalogEntry } from "../../codex/synthesize"

test("JSON and SSE echo executed tier, preserve counters, and leave unknown execution unchanged", () => {
  const body: { model: string; usage: { input_tokens: number; speed?: string }; service_tier: string } = { model: "base", usage: { input_tokens: 0 }, service_tier: "priority" }
  expect(selectedTierBody("responses", body, "default")).toEqual({ ...body, service_tier: "default" })
  expect(selectedTierBody("messages", body, "priority").usage).toEqual({ input_tokens: 0, speed: "fast" })
  expect(selectedTierBody("messages", body, undefined)).toBe(body)
  expect(selectedTierEvent("messages", { type: "message_delta", usage: { output_tokens: 0 } }, "priority")).toMatchObject({ type: "message_delta", usage: { output_tokens: 0, speed: "fast" } })
  expect(selectedTierEvent("responses", { type: "response.completed", response: body }, "default")).toEqual({ type: "response.completed", response: { ...body, service_tier: "default" } })
  expect(selectedTierEvent("messages", { type: "error", error: {} }, "priority")).toEqual({ type: "error", error: {} })
})

test("translated hints survive until provider selection", () => {
  expect(selectedTierRequest("messages", "responses", { speed: "fast" }, { model: "m" })).toEqual({ model: "m", service_tier: "priority" })
  expect(selectedTierRequest("responses", "messages", { service_tier: "priority" }, { model: "m" })).toEqual({ model: "m", speed: "fast" })
})

test("Codex never inherits bundled Fast availability instead of the selected upstream fact", () => {
  const base = { slug: "m", service_tiers: [{ id: "priority", name: "Fast" }], additional_speed_tiers: ["fast"] }
  expect(synthesizeCatalogEntry({ id: "m" }, base).service_tiers).toEqual([])
  expect(synthesizeCatalogEntry({ id: "m", service_tiers: { responses: ["priority"] } }, base).service_tiers).toEqual([{ id: "priority", name: "Fast" }])
})

test("Codex advertises only the chosen native endpoint's lane, including Messages translation", () => {
  const supported = { id: "claude-opus-4.8", supported_endpoints: ["/v1/messages"], service_tiers: { messages: ["priority"] } }
  expect(synthesizeCatalogEntry(supported).service_tiers).toEqual([{ id: "priority", name: "Fast" }])
  expect(synthesizeCatalogEntry({ ...supported, supported_endpoints: ["/responses", "/v1/messages"] }).service_tiers).toEqual([])
})

test("Messages JSON reassembly preserves the selected usage speed", async () => {
  const { collectMessagesProtocolEventsToResult } = await import("../messages/events/reassemble")
  const { synthesizeMessagesFramesFromJson } = await import("../messages/attempt")
  const { selectedTierFrames } = await import("./execution-tier")
  const frames = synthesizeMessagesFramesFromJson({ id: "msg", model: "base", content: [], usage: { input_tokens: 0, output_tokens: 0 } })
  const result = await collectMessagesProtocolEventsToResult(selectedTierFrames("messages", frames, "priority"))
  expect(result.usage.speed).toBe("fast")
  expect(result.usage.input_tokens).toBe(0)
})
