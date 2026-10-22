import { expect, test } from "bun:test"
import { setupTestPlatform } from "./_setup-platform"
import { app } from "../src/app"
import { _clearModelsMemoForTest } from "../src/data-plane/providers/registry"
import { __resetPlatformForTests } from "@vibe-core/platform"
import type { UserId } from "../src/repo/branded-ids"

test("persisted Loki credentials drive catalog discovery and all three native inference routes", async () => {
  const { db, repo } = setupTestPlatform()
  const originalFetch = globalThis.fetch
  const owner = "loki-inference-owner" as UserId
  const now = new Date().toISOString()
  const calls: string[] = []
  let textOnly = false
  const billing = { price_unit: "CopilotCredit", cost_per_input_token: 0.00044, cost_per_output_token: 0.0022,
    cache_read_cost_per_token: 0.000022, cache_write_cost_per_token: 0.00055 }
  const catalog = { data: [
    { id: "fixture-messages", supported_endpoints: ["/v1/messages"], billing },
    { id: "fixture-responses", supported_endpoints: ["/responses"] },
    { id: "fixture-chat", supported_endpoints: ["/chat/completions"] },
    { id: "claude-haiku-5.5", supported_endpoints: ["/v1/messages"] },
    { id: "claude-opus-5.5", supported_endpoints: ["/v1/messages"] },
  ] }
  try {
    await repo.users.create({ id: owner, name: "Fixture", disabled: false, createdAt: now })
    await repo.apiKeys.save({ id: "loki-fixture-inference", name: "fixture", key: "loki-native-fixture-key", ownerId: owner,
      modelMappingsEnabled: false, modelMappings: [], createdAt: now,
      webSearchEnabled: true, webSearchPriority: ["tavily"], webSearchTavilyKey: "fixture-search-key" })
    const account = { homeAccountId: "fixture-home", tenantId: "11111111-1111-4111-8111-111111111111" }
    await repo.upstreams.save({ id: "loki-native-fixture", provider: "loki", ownerId: owner, name: "Loki fixture", enabled: true,
      sortOrder: 0, config: { profileId: "loki-df-v1" }, flagOverrides: {}, disabledPublicModelIds: [],
      proxyFallbackList: [{ id: "direct_fetch" }], createdAt: now, updatedAt: now,
      state: { version: 1, profileId: "loki-df-v1", generation: "fixture-generation", revision: 1,
        syncSecretHash: "fixture-hash", assistantStatus: "authorized", account,
        credential: { accessToken: "loki-upstream-fixture-token", tokenType: "Bearer", account, expiresAt: Date.now() + 3_600_000 } },
    })
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === "https://api.tavily.com/search") {
        return Response.json({ results: [{ title: "Fixture result", url: "https://example.com/fixture", content: "Fixture search result" }] })
      }
      expect(url.startsWith("https://df.loki.delve.office.com/api/v1/llmapi/")).toBe(true)
      const headers = new Headers(init?.headers)
      expect(headers.get("authorization")).toBe("Bearer loki-upstream-fixture-token")
      expect(headers.get("X-ClientType")).toBe("Copilot")
      expect(headers.get("X-ClientFeature")).toBe("LlmApiProxy")
      expect(init?.redirect).toBe("manual")
      calls.push(url)
      if (url.endsWith("/models")) return Response.json(catalog)
      if (!headers.get("X-ConversationId")) return new Response("Missing required header 'X-ConversationId'.", { status: 400 })
      // Messages exposes allowlisted client headers; the other native entry
      // points currently supply no client headers, so Loki must derive an ID.
      if (url.endsWith("/v1/messages")) expect(headers.get("X-ConversationId")).toBe("fixture-conversation")
      else expect(headers.get("X-ConversationId")).toMatch(/^[a-f0-9-]{36}$/)
      const body = JSON.parse(String(init?.body)) as { model: string; thinking?: { type: string }; tool_choice?: { type: string }; tools?: Array<{ name: string; type?: string; input_schema?: unknown }> }
      if (body.model.startsWith("claude-")) {
        if (body.thinking?.type === "enabled" || (body.model === "claude-opus-5.5" && (body.thinking?.type === "disabled" || body.tool_choice?.type === "tool"))) {
          return Response.json({ type: "error", error: { type: "invalid_request_error", message: "Upstream rejected the request." } }, { status: 400 })
        }
        expect(body.tools?.[0]?.name).toBe("web_search")
        expect(body.tools?.[0]?.type).toBeUndefined()
        expect(body.tools?.[0]?.input_schema).toBeDefined()
        if (textOnly) return Response.json({ id: "msg_no_search", type: "message", role: "assistant", model: body.model,
          content: [{ type: "text", text: "Unsearched fixture answer" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 2, output_tokens: 3 } })
        const events = [
          { type: "message_start", message: { id: "msg_search", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } },
          { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_search", name: "web_search", input: {} } },
          { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ query: "fixture" }) } },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 10 } },
          { type: "message_stop" },
        ]
        return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } })
      }
      if (url.endsWith("/v1/messages")) return Response.json({ id: "msg_fixture", type: "message", role: "assistant", model: "fixture-messages",
        content: [{ type: "text", text: "fixture answer" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 2, output_tokens: 3, cache_read_input_tokens: 5, cache_creation_input_tokens: 7 } })
      if (url.endsWith("/responses")) return Response.json({ id: "resp_fixture", object: "response", model: "fixture-responses", status: "completed",
        output: [{ id: "msg_fixture", type: "message", role: "assistant", content: [{ type: "output_text", text: "fixture answer", annotations: [] }] }],
        usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } })
      if (url.endsWith("/chat/completions")) return Response.json({ id: "chatcmpl_fixture", object: "chat.completion", model: "fixture-chat",
        choices: [{ index: 0, message: { role: "assistant", content: "fixture answer" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } })
      throw new Error("Unexpected fixture egress")
    }) as typeof fetch
    const headers = { authorization: "Bearer loki-native-fixture-key", "content-type": "application/json", "X-ConversationId": "fixture-conversation" }
    const models = await app.request("https://gateway.example/v1/models", { headers })
    expect(models.status).toBe(200)
    const discovered = await models.json() as { data: Array<{ id: string; supported_endpoints: string[] }> }
    expect(discovered.data.map(model => model.id)).toEqual(catalog.data.map(model => model.id))
    const requests = [
      { path: "/v1/messages", body: { model: "fixture-messages", max_tokens: 16, messages: [{ role: "user", content: "hello" }] } },
      { path: "/v1/responses", body: { model: "fixture-responses", input: "hello" } },
      { path: "/v1/chat/completions", body: { model: "fixture-chat", messages: [{ role: "user", content: "hello" }] } },
    ]
    for (const { path, body } of requests) {
      const response = await app.request(`https://gateway.example${path}`, { method: "POST", headers, body: JSON.stringify(body) })
      const text = await response.text()
      expect(response.status, text).toBe(200)
      expect(text).toContain("fixture answer")
    }
    const priced = (await repo.usage.listAll()).find(row => row.model === "fixture-messages")
    expect(priced?.tokens).toEqual({ input: 2, output: 3, input_cache_read: 5, input_cache_write: 7 })
    expect(priced?.cost).toEqual({ input: 4.4, output: 22, input_cache_read: 0.22, input_cache_write: 5.5 })
    const unpriced = (await repo.usage.listAll()).find(row => row.model === "fixture-responses")
    expect(unpriced?.cost).toBeNull()
    for (const [model, thinking] of [
      ["claude-haiku-5.5", { type: "enabled", budget_tokens: 1024 }],
      ["claude-opus-5.5", { type: "disabled" }],
    ]) {
      const response = await app.request("https://gateway.example/v1/messages", { method: "POST", headers,
        body: JSON.stringify({ model, thinking, stream: true, max_tokens: 1200,
          ...(model === "claude-opus-5.5" ? { tool_choice: { type: "tool", name: "web_search" } } : {}),
          messages: [{ role: "user", content: "Search for a fixture" }], tools: [{ type: "web_search_20250305", name: "web_search" }] }) })
      const text = await response.text()
      expect(response.status, text).toBe(200)
      expect(text).toContain("server_tool_use")
      expect(text).toContain("web_search_tool_result")
      expect(text).toContain("https://example.com/fixture")
    }
    textOnly = true
    for (const stream of [false, true]) {
      const response = await app.request("https://gateway.example/v1/messages", { method: "POST", headers,
        body: JSON.stringify({ model: "claude-opus-5.5", thinking: { type: "disabled" }, stream, max_tokens: 1200,
          tool_choice: { type: "tool", name: "web_search" },
          messages: [{ role: "user", content: "Search for a fixture" }], tools: [{ type: "web_search_20250305", name: "web_search" }] }) })
      const text = await response.text()
      expect(response.status).toBe(stream ? 200 : 502)
      expect(text).toContain("Loki did not produce the required web_search call")
      expect(text).not.toContain("Unsearched fixture answer")
      expect(text).not.toContain("message_stop")
    }
    expect(calls.filter(url => !url.endsWith("/models"))).toHaveLength(7)
    expect(calls.filter(url => url.endsWith("/models"))).toHaveLength(1)
    // A fresh isolate must reuse the SQL publication instead of rediscovering
    // Loki's catalog for every request or isolate restart.
    _clearModelsMemoForTest()
    const coldModels = await app.request("https://gateway.example/v1/models", { headers })
    expect(coldModels.status).toBe(200)
    const coldCatalog = await coldModels.json() as { data: Array<{ id: string }> }
    expect(coldCatalog.data.map(model => model.id)).toContain("claude-opus-5.5")
    // Delete the usage fixture so a prior non-null snapshot cannot hide a lost catalog price.
    db.run("DELETE FROM usage WHERE model = 'fixture-messages'")
    db.run("DELETE FROM usage_requests WHERE model = 'fixture-messages'")
    const coldResponse = await app.request("https://gateway.example/v1/messages", { method: "POST", headers,
      body: JSON.stringify({ model: "fixture-messages", max_tokens: 16, messages: [{ role: "user", content: "hello" }] }) })
    expect(coldResponse.status).toBe(200)
    await coldResponse.text()
    const restored = (await repo.usage.listAll()).find(row => row.model === "fixture-messages")
    expect(restored?.cost).toEqual({ input: 4.4, output: 22, input_cache_read: 0.22, input_cache_write: 5.5 })
    const overview = await repo.usage.queryOverview({ start: now.slice(0, 13), end: new Date(Date.now() + 3_600_000).toISOString().slice(0, 13),
      bucket: "hour", axis: "model", model: "fixture-messages" })
    expect(overview.total.costUSD).toBeCloseTo(0.0001144, 12)
    expect(overview.total.unpricedTokens).toBe(0)
    expect(calls.filter(url => url.endsWith("/models"))).toHaveLength(1)
  } finally {
    globalThis.fetch = originalFetch
    _clearModelsMemoForTest()
    __resetPlatformForTests()
    db.close()
  }
})
