import { expect, test } from "bun:test"
import type { StoredUpstreamRecord } from "@vibe-core/upstream-repo"
import type { ProviderRequest } from "@vibe-llm/provider-llm"
import { LokiProvider } from "../provider"
import { lokiModelEndpoints, normalizeLokiModels } from "../models"
import type { LokiState } from "../state"

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
      return url.endsWith("/models") ? Response.json(models) : new Response("ok")
    })
    await provider.getModels()
    for (const endpoint of ["messages", "responses", "chat_completions"] as const) {
      await provider.fetch(request({ endpoint, payload: { model: "fixture", input: "hello", messages: [{ role: "user", content: "hello" }] } }))
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
  test(`Loki accepts ${scenario.model} ${scenario.thinking.type} thinking without changing search tools or caller payload`, async () => {
    const { row } = fixture()
    let sent: Record<string, unknown> = {}
    const provider = new LokiProvider(row, async () => row, async (_url, init) => {
      sent = JSON.parse(String(init.body)) as Record<string, unknown>
      return new Response("ok")
    })
    provider.setModelCatalog(normalizeLokiModels({ data: [{ id: scenario.model, supported_endpoints: ["/v1/messages"] }] }))
    const payload = { model: scenario.model, messages: [{ role: "user", content: "Search for a fixture" }], max_tokens: 1200,
      thinking: scenario.thinking, temperature: scenario.temperature, output_config: { effort: "low" },
      tools: [{ name: "web_search", input_schema: { type: "object", properties: { query: { type: "string" } } } }] }
    const before = JSON.stringify(payload)
    await provider.fetch(request({ payload }))
    expect(sent.thinking).toEqual(scenario.expected)
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
