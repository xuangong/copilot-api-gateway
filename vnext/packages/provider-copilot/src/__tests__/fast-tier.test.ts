import { describe, expect, test } from "bun:test"
import { copilotVariantIndex, selectCopilotVariant } from "../variants"
import { CopilotProvider } from "../provider"
import type { Model, ModelsResponse } from "../models"
import { clearRawModelsCache } from "../raw-models-cache"

const model = (id: string, endpoints = ["/responses", "/v1/messages"]): Model => ({
  id, name: `Display ${id}`, version: id, object: "model", vendor: "test",
  preview: false, model_picker_enabled: true, supported_endpoints: endpoints,
  capabilities: { family: id, limits: {}, supports: {}, object: "model_capabilities", tokenizer: "test", type: "chat" },
})
const catalog = (...ids: string[]): ModelsResponse => ({ object: "list", data: ids.map(id => model(id)) })

describe("catalog-backed Fast lanes", () => {
  test("one index preserves raw IDs and both display names; unrelated fast stays separate", () => {
    const index = copilotVariantIndex(catalog("gpt-5.6-sol", "gpt-5.6-sol-fast", "grok-code-fast").data)
    expect(index.families.get("gpt-5.6-sol")?.map(row => [row.id, row.name])).toEqual([
      ["gpt-5.6-sol", "Display gpt-5.6-sol"], ["gpt-5.6-sol-fast", "Display gpt-5.6-sol-fast"],
    ])
    expect(index.publicIdOf("grok-code-fast")).toBe("grok-code-fast")
    expect(index.isFast("grok-code-fast")).toBe(false)
  })
  test("selects priority, preserves raw pins, and supports the reference canonical Claude exception", () => {
    const rows = catalog("gpt-5.6-sol", "gpt-5.6-sol-fast", "claude-opus-4.8-fast")
    expect(selectCopilotVariant(rows, "gpt-5.6-sol", "responses", { fast: true })).toEqual({ modelKey: "gpt-5.6-sol-fast", serviceTier: "priority" })
    expect(selectCopilotVariant(rows, "gpt-5.6-sol-fast", "responses", {})).toEqual({ modelKey: "gpt-5.6-sol-fast", serviceTier: "priority" })
    expect(selectCopilotVariant(rows, "claude-opus-4.8", "messages", { fast: true }).modelKey).toBe("claude-opus-4.8-fast")
  })
  test("missing or unsupported lanes never report priority; non-inference endpoints never select Fast", () => {
    const rows = catalog("gpt-5.6-sol")
    rows.data.push(model("gpt-5.6-sol-fast", ["/responses"]))
    expect(selectCopilotVariant(rows, "gpt-5.6-sol", "messages", { fast: true }).serviceTier).toBe("default")
    for (const endpoint of ["messages_count_tokens", "embeddings", "images_generations"] as const) {
      expect(selectCopilotVariant(rows, "gpt-5.6-sol", endpoint, { fast: true })).toEqual({ modelKey: "gpt-5.6-sol" })
    }
  })
  test("Fast respects context and effort capabilities and exact effort raw pins", () => {
    const rows = catalog("claude-opus-4.8", "claude-opus-4.8-high", "claude-opus-4.8-fast")
    const fast = rows.data[2]
    if (!fast) throw new Error("fixture missing")
    fast.capabilities.supports.reasoning_effort = ["high"]
    fast.capabilities.limits.max_context_window_tokens = 1_000_000
    expect(selectCopilotVariant(rows, "claude-opus-4.8", "messages", { fast: true, context1m: true, reasoningEffort: "high" }).serviceTier).toBe("priority")
    expect(selectCopilotVariant(rows, "claude-opus-4.8", "messages", { fast: true, reasoningEffort: "xhigh" }).serviceTier).toBe("default")
    expect(selectCopilotVariant(rows, "claude-opus-4.8-high", "messages", { fast: true }).modelKey).toBe("claude-opus-4.8-high")
  })
})

test("provider selects before stripping and returns immutable actual execution identity", async () => {
  clearRawModelsCache()
  const sent: Record<string, unknown>[] = []
  const provider = new CopilotProvider({ copilotToken: "fast-fixture", accountType: "individual" }, async (_url, init) => {
    sent.push(JSON.parse(String(init.body)) as Record<string, unknown>)
    return Response.json({ id: "resp_fast", object: "response", status: "completed", model: "gpt-5.6-sol", output: [], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } })
  })
  provider.setModelCatalog(catalog("gpt-5.6-sol", "gpt-5.6-sol-fast"))
  const response = await provider.fetch({ endpoint: "responses", sourceApi: "openai", sourceProtocol: "responses", headers: new Headers(), payload: { model: "gpt-5.6-sol", service_tier: "priority", input: [] } })
  expect(sent[0]?.model).toBe("gpt-5.6-sol-fast")
  expect(sent[0]?.service_tier).toBeUndefined()
  expect(response.execution).toEqual({ modelKey: "gpt-5.6-sol-fast", serviceTier: "priority" })
  expect(Object.isFrozen(response.execution)).toBe(true)
})

test("missing Messages Fast returns a protocol error without inference, including translated Messages", async () => {
  for (const endpoint of ["messages", "responses"] as const) {
    const provider = new CopilotProvider({ copilotToken: `missing-${endpoint}`, accountType: "individual" }, async () => { throw new Error("must not dispatch") })
    provider.setModelCatalog(catalog("claude-opus-4.8"))
    const response = await provider.fetch({ endpoint, sourceApi: "anthropic", sourceProtocol: "messages", headers: new Headers(), payload: { model: "claude-opus-4.8", ...(endpoint === "messages" ? { speed: "fast", messages: [], max_tokens: 8 } : { service_tier: "priority", input: [] }) } })
    expect(response.status).toBe(400)
    expect(await new Response(response.body).json()).toMatchObject({ type: "error", error: { type: "invalid_request_error" } })
  }
})

test("Fast-only default executes its only proved lane and advertises only supported endpoints", () => {
  const rows = { object: "list", data: [model("claude-opus-4.8-fast", ["/v1/messages"])] }
  expect(selectCopilotVariant(rows, "claude-opus-4.8", "messages")).toEqual({ modelKey: "claude-opus-4.8-fast", serviceTier: "priority" })
})

test("catalog rows retain both labels and raw pins without promising a different pinned lane", async () => {
  const { catalogWithCopilotVariants } = await import("../variants")
  const rows = catalog("claude-opus-4.8", "claude-opus-4.8-high", "claude-opus-4.8-fast", "grok-code-fast")
  const base = rows.data[0]
  if (!base) throw new Error("fixture missing")
  base.display_name = "Opus display label"
  const listed = catalogWithCopilotVariants(rows)
  expect(listed.data[0]).toMatchObject({ id: base.id, name: base.name, display_name: "Opus display label", service_tiers: { responses: ["priority"], messages: ["priority"], chat_completions: [] } })
  expect(listed.data[1]?.service_tiers?.messages).toEqual([])
  expect(listed.data[2]?.variant_family).toBe("claude-opus-4.8")
  expect(listed.data[3]?.service_tiers?.responses).toEqual([])
  expect(listed.data[0]?.variant_models?.[0]?.display_name).toBe("Opus display label")
})

test("exact fast prices remain distinct from base prices without inferred multipliers", () => {
  const provider = new CopilotProvider({ copilotToken: "pricing", accountType: "individual" })
  expect(provider.getPricingForModelKey("claude-opus-4.8")).toMatchObject({ input: 5, output: 25 })
  expect(provider.getPricingForModelKey("claude-opus-4.8-fast")).toMatchObject({ input: 10, output: 50 })
  expect(provider.getPricingForModelKey("unknown-fast")).toBeNull()
})

for (const scenario of [
  { name: "context beta", modelId: "claude-opus-4.8", beta: true, effort: undefined, expected: "claude-opus-4.8-1m-internal" },
  { name: "effort", modelId: "claude-opus-4.8", beta: false, effort: "high", expected: "claude-opus-4.8-high" },
  { name: "non-raw composite", modelId: "claude-opus-4.8-xhigh-1m", beta: false, effort: undefined, expected: "claude-opus-4.8-1m-internal" },
]) {
  test(`count-tokens preserves ordinary ${scenario.name} selection without Fast tier`, async () => {
    const rows = catalog("claude-opus-4.8", "claude-opus-4.8-high", "claude-opus-4.8-1m-internal", "claude-opus-4.8-fast")
    for (const row of rows.data) {
      row.capabilities.supports.reasoning_effort = row.id.endsWith("high") ? ["high"] : row.id.endsWith("internal") ? ["xhigh"] : ["low"]
      if (row.id.endsWith("fast")) {
        row.capabilities.supports.reasoning_effort = ["high", "xhigh"]
        row.capabilities.limits.max_context_window_tokens = 1_000_000
      }
    }
    const sent: { payload: Record<string, unknown>; headers: Headers; url: string }[] = []
    const provider = new CopilotProvider({ copilotToken: `count-${scenario.name}`, accountType: "individual" }, async (url, init) => {
      sent.push({ payload: JSON.parse(String(init.body)) as Record<string, unknown>, headers: new Headers(init.headers), url })
      return Response.json({ input_tokens: 12 })
    })
    provider.setModelCatalog(rows)
    const response = await provider.fetch({
      endpoint: "messages_count_tokens", sourceApi: "anthropic", sourceProtocol: "messages",
      headers: new Headers(scenario.beta ? { "anthropic-beta": "context-1m-2025-08-07,context-management-2025-06-27" } : {}),
      payload: { model: scenario.modelId, messages: [{ role: "user", content: "count fixture" }], speed: "fast", ...(scenario.effort ? { output_config: { effort: scenario.effort } } : {}) },
    })
    expect(response.status).toBe(200)
    expect(sent).toHaveLength(1)
    expect(sent[0]?.url).toEndWith("/v1/messages/count_tokens")
    expect(sent[0]?.payload.model).toBe(scenario.expected)
    expect(sent[0]?.headers.get("anthropic-beta") ?? "").not.toContain("context-1m")
    if (scenario.beta) expect(sent[0]?.headers.get("anthropic-beta")).toBe("context-management-2025-06-27")
    expect(response.execution).toBeUndefined()
    expect(await new Response(response.body).json()).toEqual({ input_tokens: 12 })
  })
}
