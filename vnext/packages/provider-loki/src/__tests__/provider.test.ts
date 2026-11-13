import { expect, test } from "bun:test"
import type { StoredUpstreamRecord } from "@vibe-core/upstream-repo"
import type { ProviderRequest } from "@vibe-llm/provider-llm"
import { LokiProvider } from "../provider"
import { lokiContextWindow, lokiModelEndpoints, normalizeLokiModels } from "../models"
import type { LokiState } from "../state"
import { normalizeLokiConfig, normalizeLokiStaticModels } from "../config"

const catalog = { data: [
  { id: "messages-model", supported_endpoints: ["/v1/messages"], display_name: "Messages model" },
  { id: "responses-model", supported_endpoints: ["/responses"] },
  { id: "gpt-unknown" },
] }
function fixture() {
  const state: LokiState = { version: 1, profileId: "loki-df-v1", generation: "generation", revision: 1,
    syncSecretHash: "hash", assistantStatus: "authorized", account: { homeAccountId: "home", tenantId: "11111111-1111-4111-8111-111111111111" },
    credential: { accessToken: "test-private-token", tokenType: "Bearer", expiresAt: Date.now() + 3_600_000,
      account: { homeAccountId: "home", tenantId: "11111111-1111-4111-8111-111111111111" } } }
  const row: StoredUpstreamRecord<LokiState> = { id: "up_loki", rowIncarnation: "incarnation", ownerId: "owner", provider: "loki",
    name: "Loki", enabled: true, sortOrder: 0, config: { profileId: "loki-df-v1" }, state,
    catalogGeneration: 0, credentialGeneration: 0, flagOverrides: {}, disabledPublicModelIds: [], proxyFallbackList: [], createdAt: "", updatedAt: "" }
  return { state, row }
}
const request = (overrides: Partial<ProviderRequest> = {}): ProviderRequest => ({
  endpoint: "messages", payload: { model: "messages-model", messages: [{ role: "user", content: "hello" }], max_tokens: 10 },
  headers: new Headers({ authorization: "Bearer attacker" }), sourceApi: "anthropic", ...overrides,
})

test("static names are validated and survive configuration normalization", () => {
  expect(normalizeLokiConfig({ profileId: "loki-df-v1", staticModels: [" claude-opus-5.5 ", "claude-opus-5.5"] }))
    .toEqual({ profileId: "loki-df-v1", staticModels: ["claude-opus-5.5"] })
  expect(normalizeLokiConfig({ profileId: "loki-df-v1", staticModels: [] })).toEqual({ profileId: "loki-df-v1" })
  for (const value of [null, "claude-opus-5.5", [1], [""], ["a b"], ["a,b"], ["a\nb"], ["x".repeat(513)], Array(257).fill("x")]) {
    expect(() => normalizeLokiStaticModels(value)).toThrow("loki_invalid_static_models")
  }
})

test("static discovery needs no network; live probes cannot replace the inference catalog", async () => {
  const { row } = fixture()
  const ids = ["claude-opus-5.5", "gpt-6-luna"]
  row.config.staticModels = ids
  let offline = true
  let calls = 0
  const provider = new LokiProvider(row, async () => row, async url => {
    calls++
    if (url.endsWith("/models")) {
      if (offline) throw new Error("TLS timeout")
      return Response.json(catalog)
    }
    return new Response("ok")
  })
  const models = await provider.getModels()
  expect(calls).toBe(0)
  expect(models.data.map(model => model.id)).toEqual(ids)
  expect(lokiModelEndpoints(models.data[0])).toEqual({ messages: {} })
  expect(lokiModelEndpoints(models.data[1])).toEqual({ responses: {} })
  expect((await provider.probe()).ok).toBe(false)
  offline = false
  expect(await provider.probe()).toMatchObject({ ok: true, models: ["messages-model", "responses-model"] })
  await provider.fetch(request({ payload: { model: "claude-opus-5.5", messages: [] } }))
  await provider.fetch(request({ endpoint: "responses", payload: { model: "gpt-6-luna", input: "hi" } }))
  await expect(provider.fetch(request())).rejects.toThrow("loki_endpoint_unavailable")
  expect((await provider.getModels()).data.map(model => model.id)).toEqual(ids)
  expect(calls).toBe(4)
})

test("static names of known Loki models keep their pricing, context window and endpoints", async () => {
  const { row } = fixture()
  row.config.staticModels = ["claude-opus-5.5", "gpt-61-sol", "claude-future-x", "constructor"]
  const provider = new LokiProvider(row, async () => row, async () => { throw new Error("no network") })
  const byId = new Map((await provider.getModels()).data.map(model => [model.id, model]))
  const opus = provider.getPricingForModelKey("claude-opus-5.5")
  expect(opus?.input).toBeCloseTo(4.4)
  expect(opus?.output).toBeCloseTo(22)
  expect(opus?.input_cache_read).toBeCloseTo(0.22)
  expect(opus?.input_cache_write).toBeCloseTo(5.5)
  expect(provider.getPricingForModelKey("gpt-61-sol")?.output).toBeCloseTo(11)
  expect(lokiContextWindow(byId.get("claude-opus-5.5"))).toBe(1_000_000)
  expect(lokiContextWindow(byId.get("gpt-61-sol"))).toBe(1_050_000)
  expect(lokiModelEndpoints(byId.get("gpt-61-sol"))).toEqual({ responses: {} })
  expect(byId.get("claude-opus-5.5")).toMatchObject({ vendor: "Anthropic" })
  // An unknown name still routes by its prefix, but is never given a price.
  expect(lokiModelEndpoints(byId.get("claude-future-x"))).toEqual({ messages: {} })
  expect(provider.getPricingForModelKey("claude-future-x")).toBeNull()
  expect(lokiModelEndpoints(byId.get("constructor"))).toEqual({ responses: {} })
  expect(provider.getPricingForModelKey("constructor")).toBeNull()
})

test("a live refresh that drops names keeps what this configuration already published", () => {
  const { row } = fixture()
  const previous = normalizeLokiModels(catalog)
  // Loki answering with part of its list while a backend is unreachable.
  const partial = normalizeLokiModels({ data: [catalog.data[1], { id: "new-model", supported_endpoints: ["/responses"] }] })
  const live = new LokiProvider(row, async () => row)
  expect(live.reconcileCatalog(previous, partial).data.map(model => model.id)).toEqual(["responses-model", "new-model", "messages-model"])
  // A new configuration generation has no previous catalog: publish as given.
  expect(live.reconcileCatalog(null, partial)).toBe(partial)
  // A static list is the operator's word; removals there are real.
  row.config.staticModels = ["responses-model"]
  expect(new LokiProvider(row, async () => row).reconcileCatalog(previous, partial)).toBe(partial)
})

test("a name Loki keeps leaving out is dropped after a day, and one that returns is fresh", () => {
  const { row } = fixture()
  const live = new LokiProvider(row, async () => row)
  const day = 24 * 60 * 60 * 1000
  const t0 = 1_800_000_000_000
  const previous = normalizeLokiModels(catalog)
  const partial = normalizeLokiModels({ data: [catalog.data[1]] })
  const first = live.reconcileCatalog(previous, partial, t0)
  expect(first.data.find(model => model.id === "messages-model")).toMatchObject({ _loki_missing_since: t0 })
  // Later refreshes keep the first time it went missing.
  const later = live.reconcileCatalog(first, partial, t0 + day - 1)
  expect(later.data.find(model => model.id === "messages-model")).toMatchObject({ _loki_missing_since: t0 })
  expect(live.reconcileCatalog(later, partial, t0 + day).data.map(model => model.id)).toEqual(["responses-model"])
  // Listed again: the entry comes from Loki's answer, with no missing stamp.
  const back = live.reconcileCatalog(later, previous, t0 + day - 1)
  expect(back.data.find(model => model.id === "messages-model")).not.toHaveProperty("_loki_missing_since")
})

test("catalog advertises only explicit Loki endpoints", () => {
  const models = normalizeLokiModels(catalog)
  expect(models.data.map(model => model.id)).toEqual(["messages-model", "responses-model"])
  expect(lokiModelEndpoints(models.data[0])).toEqual({ messages: {} })
  expect(lokiModelEndpoints(models.data[1])).toEqual({ responses: {} })
  expect(lokiModelEndpoints({ id: "gpt-guess" })).toEqual({})
})

test("discovery and inference use fixed Loki egress and authoritative bearer credentials", async () => {
  const { row } = fixture()
  const seen: Array<{ url: string; headers: Headers }> = []
  const provider = new LokiProvider(row, async () => row, async (url, init) => {
    seen.push({ url, headers: new Headers(init.headers) })
    return url.endsWith("/models") ? Response.json(catalog) : new Response("data: fixture\n\n", { headers: { "content-type": "text/event-stream" } })
  })
  await provider.getModels()
  const result = await provider.fetch(request())
  expect(await new Response(result.body).text()).toBe("data: fixture\n\n")
  expect(seen[1]?.url).toBe("https://loki.delve.office.com/api/v1/llmapi/v1/messages")
  expect(seen[1]?.headers.get("authorization")).toBe("Bearer test-private-token")
  expect(seen[1]?.headers.get("X-ClientFeature")).toBe("LlmApiProxy")
})

test("each upstream uses its configured prefix for discovery and all native inference routes", async () => {
  for (const baseUrl of ["https://df.loki.delve.office.com/api/v1/llmapi/", "https://loki.example/custom/prefix///"]) {
    const { row } = fixture()
    row.config.baseUrl = baseUrl
    const seen: string[] = []
    const models = { data: [{ id: "fixture", supported_endpoints: ["/v1/messages", "/responses", "/chat/completions"] }] }
    const provider = new LokiProvider(row, async () => row, async (url, init) => {
      seen.push(url)
      expect(init.redirect).toBe("manual")
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer test-private-token")
      expect(new Headers(init.headers).get("X-Llm-Api-Version")).toBe("2026-10-21")
      expect(new Headers(init.headers).get("anthropic-version")).toBe(url.endsWith("/v1/messages") ? "2023-06-01" : null)
      expect(new Headers(init.headers).get("anthropic-beta")).toBe(url.endsWith("/v1/messages") ? "thinking-display-updates-2026-08-18" : null)
      expect(new Headers(init.headers).get("X-ClientFeature")).toBe("LlmApiProxy")
      expect(new Headers(init.headers).get("X-ClientScenario")).toBe("Code")
      expect(new Headers(init.headers).get("X-ClientType")).toBe("Copilot")
      expect(new Headers(init.headers).get("X-HostPlatform")).toBe("Windows")
      return url.endsWith("/models") ? Response.json(models) : new Response("ok")
    })
    await provider.getModels()
    for (const endpoint of ["messages", "responses", "chat_completions"] as const) {
      await provider.fetch(request({ endpoint, headers: new Headers({ "X-Llm-Api-Version": "invalid-client-version", "anthropic-version": "2026-10-21" }),
        payload: { model: "fixture", input: "hello", messages: [{ role: "user", content: "hello" }], thinking: { type: "adaptive", display: "updates" } } }))
    }
    const prefix = baseUrl.replace(/\/+$/, "")
    expect(seen).toEqual([`${prefix}/models`, `${prefix}/v1/messages`, `${prefix}/responses`, `${prefix}/chat/completions`])
  }
})

test("an endpoint change fences an existing provider before sending credentials", async () => {
  const { row } = fixture()
  let calls = 0
  const latest = { ...row, config: { ...row.config, baseUrl: "https://changed.example/api" } }
  const provider = new LokiProvider(row, async () => latest, async () => { calls++; return new Response("ok") })
  provider.setModelCatalog(normalizeLokiModels(catalog))
  await expect(provider.getModels()).rejects.toThrow("loki_binding_replaced")
  await expect(provider.fetch(request())).rejects.toThrow("loki_binding_replaced")
  expect(calls).toBe(0)
})

test("invalid configured endpoints are rejected before any credential can leave", () => {
  for (const baseUrl of ["http://loki.example/api", "https://user:secret@loki.example/api", "https://loki.example/api?key=secret",
    "https://loki.example/api#fragment", "not-a-url", 123, "https://loki.example/\\evil"]) {
    const { row } = fixture()
    row.config.baseUrl = baseUrl
    expect(() => new LokiProvider(row, async () => row)).toThrow("loki_invalid_endpoint")
  }
})

test("expired or replaced credentials never cause an upstream request", async () => {
  const { row, state } = fixture()
  let latest = row
  let calls = 0
  const provider = new LokiProvider(row, async () => latest, async () => { calls++; return Response.json({}) })
  provider.setModelCatalog(normalizeLokiModels(catalog))
  const original = state.credential
  if (!original) throw new Error("fixture credential missing")
  latest = { ...row, state: { ...state, credential: { ...original, expiresAt: Date.now() - 1 } } }
  await expect(provider.fetch(request())).rejects.toThrow("loki_credential_unavailable")
  latest = { ...row, credentialGeneration: 1 }
  await expect(provider.fetch(request())).rejects.toThrow("loki_binding_replaced")
  for (const change of [{ rowIncarnation: "recreated" }, { ownerId: "another-owner" }, { catalogGeneration: 1 }, { enabled: false }]) {
    latest = { ...row, ...change }
    await expect(provider.fetch(request())).rejects.toThrow("loki_binding_replaced")
  }
  expect(calls).toBe(0)
})

test("model endpoint mismatch and aborted requests fail before egress", async () => {
  const { row } = fixture()
  let calls = 0
  const provider = new LokiProvider(row, async () => row, async () => { calls++; return Response.json({}) })
  provider.setModelCatalog(normalizeLokiModels(catalog))
  await expect(provider.fetch(request({ endpoint: "responses" }))).rejects.toThrow("loki_endpoint_unavailable")
  const controller = new AbortController()
  controller.abort()
  await expect(provider.fetch(request({ signal: controller.signal }))).rejects.toThrow()
  expect(calls).toBe(0)
})

test("inference supplies a stable conversation header across turns without exposing prompt text", async () => {
  const { row } = fixture()
  const ids: Array<string | null> = []
  const provider = new LokiProvider(row, async () => row, async (_url, init) => {
    ids.push(new Headers(init.headers).get("X-ConversationId"))
    return new Response("ok")
  })
  provider.setModelCatalog(normalizeLokiModels(catalog))
  const first = { role: "user", content: "private first message" }
  for (const messages of [[first], [first, { role: "assistant", content: "answer" }, { role: "user", content: "next turn" }],
    [{ role: "user", content: "different conversation" }]]) {
    await provider.fetch(request({ payload: { model: "messages-model", system: "private system", messages } }))
  }
  expect(ids[0]).toMatch(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/)
  expect(ids[1]).toBe(ids[0])
  expect(ids[2]).not.toBe(ids[0])
  expect(ids.join()).not.toContain("private")
})

test("explicit conversation and session headers take precedence over the derived fallback", async () => {
  const { row } = fixture()
  const ids: Array<string | null> = []
  const provider = new LokiProvider(row, async () => row, async (_url, init) => {
    ids.push(new Headers(init.headers).get("X-ConversationId"))
    return new Response("ok")
  })
  provider.setModelCatalog(normalizeLokiModels(catalog))
  for (const headers of [new Headers({ "X-ConversationId": "explicit-conversation", "session-id": "session" }),
    new Headers({ "session-id": "client-session" }), new Headers({ "X-ConversationId": "x".repeat(1025) })]) {
    await provider.fetch(request({ headers }))
  }
  expect(ids[0]).toBe("explicit-conversation")
  expect(ids[1]).toBe("client-session")
  expect(ids[2]).toMatch(/^[a-f0-9-]{36}$/)
})

test("Responses and Chat Completions derive conversation IDs from the first user turn", async () => {
  const { row } = fixture()
  const ids: Array<string | null> = []
  const provider = new LokiProvider(row, async () => row, async (_url, init) => {
    ids.push(new Headers(init.headers).get("X-ConversationId"))
    return new Response("ok")
  })
  provider.setModelCatalog(normalizeLokiModels({ data: [
    { id: "responses-model", supported_endpoints: ["/responses"] },
    { id: "chat-model", supported_endpoints: ["/chat/completions"] },
  ] }))
  for (const input of ["first question", [{ role: "user", content: "first question" }, { role: "assistant", content: "reply" }],
    [{ role: "user", content: [{ type: "input_text", text: "another question" }] }]]) {
    await provider.fetch(request({ endpoint: "responses", payload: { model: "responses-model", instructions: "system", input } }))
  }
  for (const tail of [[], [{ role: "assistant", content: "reply" }, { role: "user", content: "follow up" }]]) {
    await provider.fetch(request({ endpoint: "chat_completions", payload: { model: "chat-model", messages: [
      { role: "system", content: "system" }, { role: "user", content: "first question" }, ...tail,
    ] } }))
  }
  expect(ids.every(id => typeof id === "string" && /^[a-f0-9-]{36}$/.test(id))).toBe(true)
  expect(ids[1]).toBe(ids[0])
  expect(ids[2]).not.toBe(ids[0])
  expect(ids[4]).toBe(ids[3])
})

for (const scenario of [
  { model: "claude-opus-5.5", thinking: { type: "adaptive", display: "updates" }, temperature: undefined,
    expected: { type: "adaptive", display: "updates" }, beta: "thinking-display-updates-2026-08-18" },
  { model: "claude-opus-5.5", thinking: { type: "enabled", budget_tokens: 2048, display: "updates" }, temperature: undefined,
    expected: { type: "adaptive", display: "updates" }, beta: "thinking-display-updates-2026-08-18" },
  { model: "claude-haiku-5.5", thinking: { type: "enabled", budget_tokens: 1024 }, temperature: 1,
    expected: { type: "adaptive", display: "summarized" } },
  { model: "claude-opus-5.5", thinking: { type: "enabled", budget_tokens: 2048, display: "omitted" }, temperature: 1,
    expected: { type: "adaptive", display: "omitted" } },
  { model: "claude-sonnet-5.5", thinking: { type: "adaptive", display: "full" }, temperature: 1,
    expected: { type: "adaptive", display: "full" } },
  { model: "claude-opus-5.5", thinking: { type: "disabled" }, temperature: undefined, expected: undefined },
  { model: "claude-sonnet-5.5", thinking: { type: "disabled" }, temperature: undefined, expected: undefined },
  { model: "claude-haiku-5.5", thinking: { type: "disabled" }, temperature: undefined, expected: { type: "disabled" } },
  { model: "claude-haiku-4.5", thinking: { type: "enabled", budget_tokens: 1024 }, temperature: undefined,
    expected: { type: "enabled", budget_tokens: 1024 } },
]) {
  test(`Loki accepts ${scenario.model} ${scenario.thinking.type} thinking (${scenario.thinking.display ?? "default"}) without changing search tools or caller payload`, async () => {
    const { row } = fixture()
    let sent: Record<string, unknown> = {}
    let sentHeaders = new Headers()
    const provider = new LokiProvider(row, async () => row, async (_url, init) => {
      sentHeaders = new Headers(init.headers)
      sent = JSON.parse(String(init.body)) as Record<string, unknown>
      return new Response("ok")
    })
    provider.setModelCatalog(normalizeLokiModels({ data: [{ id: scenario.model, supported_endpoints: ["/v1/messages"] }] }))
    const payload = { model: scenario.model, messages: [{ role: "user", content: "Search for a fixture" }], max_tokens: 1200,
      thinking: scenario.thinking, temperature: scenario.temperature, output_config: { effort: "low" },
      tools: [{ name: "web_search", input_schema: { type: "object", properties: { query: { type: "string" } } } }] }
    const before = JSON.stringify(payload)
    await provider.fetch(request({ payload, headers: new Headers({ "anthropic-beta": "unknown-client-beta" }) }))
    expect(sent.thinking).toEqual(scenario.expected)
    expect(sentHeaders.get("anthropic-beta")).toBe(scenario.beta ?? null)
    expect(sent.temperature).toBe(scenario.temperature)
    expect(sent.tools).toEqual(payload.tools)
    expect(sent.output_config).toEqual({ effort: "low" })
    expect(JSON.stringify(payload)).toBe(before)
  })
}


test("pricing uses the injected catalog without network calls and follows replacement", () => {
  const { row } = fixture()
  let calls = 0
  const provider = new LokiProvider(row, async () => row, async () => { calls++; return Response.json(catalog) })
  provider.setModelCatalog(normalizeLokiModels({ data: [{ id: "messages-model", supported_endpoints: ["/v1/messages"],
    billing: { price_unit: "CopilotCredit", cost_per_input_token: 0.00044, cost_per_output_token: 0.0022 } }] }))
  for (let i = 0; i < 3; i++) expect(provider.getPricingForModelKey("messages-model")).toEqual({ input: 4.4, output: 22 })
  expect(provider.getPricingForModelKey("unknown-model")).toBeNull()
  provider.setModelCatalog(normalizeLokiModels(catalog))
  expect(provider.getPricingForModelKey("messages-model")).toBeNull()
  expect(calls).toBe(0)
})

test("Messages egress normalizes effort markers without changing caller history or other endpoints", async () => {
  const { row } = fixture()
  let sent: Record<string, unknown> = {}
  const provider = new LokiProvider(row, async () => row, async (_url, init) => {
    sent = JSON.parse(String(init.body)) as Record<string, unknown>
    return new Response("ok")
  })
  provider.setModelCatalog(normalizeLokiModels({ data: [
    { id: "claude-opus-5.5", supported_endpoints: ["/v1/messages", "/chat/completions"] },
  ] }))
  const payload = {
    model: "claude-opus-5.5", max_tokens: 128000, thinking: { type: "adaptive" },
    output_config: { effort: "medium" },
    messages: [
      { role: "user", content: "Continue" },
      { role: "system", content: [], output_config: { effort: "xhigh" } },
      { role: "assistant", content: [{ type: "thinking", thinking: "Preserve", signature: "opaque-signature" }] },
      { role: "system", content: [{ type: "text", text: "Current instruction" }], output_config: { effort: "medium" } },
    ],
    tools: [{ name: "example", input_schema: { type: "object", properties: {} } }],
  }
  const original = structuredClone(payload)
  await provider.fetch(request({ payload }))
  expect(sent.messages).toEqual([
    { role: "user", content: "Continue" },
    { role: "assistant", content: [{ type: "thinking", thinking: "Preserve", signature: "opaque-signature" }] },
    { role: "system", content: [{ type: "text", text: "Current instruction" }] },
  ])
  expect(sent.output_config).toEqual({ effort: "medium" })
  expect(sent.tools).toEqual(original.tools)
  expect(payload).toEqual(original)
  await provider.fetch(request({ endpoint: "chat_completions", payload }))
  expect(sent).toEqual(original)
})
