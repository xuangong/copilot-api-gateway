import { expect, test } from "bun:test"
import { normalizeLokiMessages } from "../messages"

test("lifts historical output config in order while preserving other top-level options", () => {
  const payload: Record<string, unknown> = {
    output_config: { effort: "low", format: { type: "json_schema" } },
    messages: [
      { role: "system", content: [{ type: "text", text: "Earlier instruction" }], output_config: { effort: "xhigh" } },
      { role: "user", content: "Continue" },
      { role: "system", content: [{ type: "text", text: "Current instruction" }], output_config: { effort: "medium" } },
    ],
  }
  normalizeLokiMessages(payload)
  expect(payload.output_config).toEqual({ effort: "medium", format: { type: "json_schema" } })
  expect(payload.messages).toEqual([
    { role: "system", content: [{ type: "text", text: "Earlier instruction" }] },
    { role: "user", content: "Continue" },
    { role: "system", content: [{ type: "text", text: "Current instruction" }] },
  ])
})

test("lifts an empty system marker's config before removing the marker", () => {
  const payload: Record<string, unknown> = {
    messages: [{ role: "user", content: "Continue" }, { role: "system", content: [], output_config: { effort: "high" } }],
  }
  normalizeLokiMessages(payload)
  expect(payload.output_config).toEqual({ effort: "high" })
  expect(payload.messages).toEqual([{ role: "user", content: "Continue" }])
})

test("only drops system messages with empty content arrays", () => {
  const payload: Record<string, unknown> = { messages: [
    { role: "system", content: [] },
    { role: "system", content: [{ type: "text", text: "Keep instructions", cache_control: { type: "ephemeral" } }] },
    { role: "user", content: [] },
    { role: "assistant", content: [] },
    { role: "system", content: "" },
  ] }
  normalizeLokiMessages(payload)
  expect(payload.messages).toEqual([
    { role: "system", content: [{ type: "text", text: "Keep instructions", cache_control: { type: "ephemeral" } }] },
    { role: "user", content: [] },
    { role: "assistant", content: [] },
    { role: "system", content: "" },
  ])
  expect(payload).not.toHaveProperty("output_config")
})

test("does not mutate nested caller messages or config during provider shallow-copy normalization", () => {
  const caller = { output_config: { effort: "low" }, messages: [
    { role: "system", content: [], output_config: { effort: "high" } },
    { role: "system", content: [{ type: "text", text: "Keep" }], output_config: { effort: "medium" } },
  ] }
  const original = structuredClone(caller)
  const payload = { ...caller }
  normalizeLokiMessages(payload)
  expect(payload.output_config).toEqual({ effort: "medium" })
  expect(payload.messages).toHaveLength(1)
  expect(caller).toEqual(original)
  const normalized = structuredClone(payload)
  normalizeLokiMessages(payload)
  expect(payload).toEqual(normalized)
})

test("ignores non-object per-message config without corrupting top-level config", () => {
  const payload: Record<string, unknown> = { output_config: { effort: "medium" }, messages: [
    { role: "user", content: "A", output_config: null },
    { role: "assistant", content: "B", output_config: ["invalid"] },
    { role: "user", content: "C", output_config: "invalid" },
    null,
  ] }
  normalizeLokiMessages(payload)
  expect(payload.output_config).toEqual({ effort: "medium" })
  expect(payload.messages).toEqual([
    { role: "user", content: "A" }, { role: "assistant", content: "B" }, { role: "user", content: "C" }, null,
  ])
})
