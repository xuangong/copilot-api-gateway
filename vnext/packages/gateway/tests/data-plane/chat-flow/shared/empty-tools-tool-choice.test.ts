import { expect, test } from "bun:test"
import { runInterceptors } from "@vibe-core/service"
import { doneFrame } from "@vibe-core/result"
import { llmEventResult, type Invocation, type RequestContext } from "@vibe-llm/protocols/common"
import { OPTIONAL_FLAGS, defaultsForUpstream } from "@vibe-llm/protocols/flags"
import { resolveEffectiveFlags } from "../../../../src/data-plane/flags/resolve"
import { chatCompletionsInterceptors } from "../../../../src/data-plane/chat-flow/chat-completions/interceptors"
import { messagesInterceptors } from "../../../../src/data-plane/chat-flow/messages/interceptors"
import { responsesInterceptors } from "../../../../src/data-plane/chat-flow/responses/interceptors"
import { initRepo } from "../../../../src/repo/index"
import type { Repo } from "../../../../src/repo/types"

const flag = "empty-tools-tool-choice-none"
const ctx: RequestContext = { requestStartedAt: Date.now() }
const identity = { incomingModel: "m", model: "m", upstream: "u", modelKey: "m", cost: null }
const result = () => llmEventResult((async function* () { yield doneFrame() })(), identity)

test("operator catalog offers the opt-in empty-tools flag", () => {
  expect(OPTIONAL_FLAGS.find((entry) => entry.id === flag)?.defaultFor).toEqual([])
})

for (const kind of ["copilot", "azure", "custom"] as const) {
  test(`${kind} defaults off and operator true/false overrides work`, () => {
    const defaults = defaultsForUpstream(kind)
    expect(defaults.has(flag)).toBe(false)
    expect(resolveEffectiveFlags(defaults, [{ [flag]: true }]).has(flag)).toBe(true)
    expect(resolveEffectiveFlags(defaults, [{ [flag]: true }, { [flag]: false }]).has(flag)).toBe(false)
  })
}

const protocols = [
  { endpoint: "chat_completions", sourceApi: "chat_completions", interceptors: chatCompletionsInterceptors, base: { model: "m", messages: [] }, none: "none", forced: { type: "function", function: { name: "f" } } },
  { endpoint: "messages", sourceApi: "messages", interceptors: messagesInterceptors, base: { model: "m", max_tokens: 32, messages: [] }, none: { type: "none" }, forced: { type: "tool", name: "f" } },
  { endpoint: "responses", sourceApi: "responses", interceptors: responsesInterceptors, base: { model: "m", input: [] }, none: "none", forced: { type: "function", name: "f" } },
] as const

for (const protocol of protocols) {
  const invoke = async (payload: Record<string, unknown>, flags: string[] = []): Promise<Record<string, unknown>> => {
    const inv: Invocation = { endpoint: protocol.endpoint, sourceApi: protocol.sourceApi, enabledFlags: new Set(flags), payload: { ...protocol.base, ...payload }, headers: {} }
    let seen: Record<string, unknown> = {}
    await runInterceptors(inv, ctx, protocol.interceptors, async () => { seen = { ...inv.payload }; return result() })
    return seen
  }
  test(`${protocol.endpoint} rewrites only explicit empty tools`, async () => {
    expect((await invoke({ tools: [], tool_choice: protocol.forced }, [flag])).tool_choice).toEqual(protocol.none)
    expect((await invoke({ tools: [], tool_choice: null }, [flag])).tool_choice).toEqual(protocol.none)
    expect((await invoke({ tools: [] }, [flag])).tool_choice).toEqual(protocol.none)
    expect((await invoke({ tools: [], tool_choice: protocol.forced })).tool_choice).toEqual(protocol.forced)
    expect((await invoke({ tool_choice: protocol.forced }, [flag])).tool_choice).toEqual(protocol.forced)
    expect((await invoke({ tools: null, tool_choice: protocol.forced }, [flag])).tool_choice).toEqual(protocol.forced)
    expect((await invoke({ tools: [{ type: "function", name: "f" }], tool_choice: protocol.forced }, [flag])).tool_choice).toEqual(protocol.forced)
  })
  test(`${protocol.endpoint} rewritten no-tools choice keeps reasoning enabled`, async () => {
    const seen = await invoke({ tools: [], tool_choice: protocol.forced, reasoning: { effort: "high" }, thinking: { type: "enabled", budget_tokens: 1024 }, reasoning_effort: "high" }, [flag, "disable-reasoning-on-forced-tool-choice"])
    expect(seen.tool_choice).toEqual(protocol.none)
    expect(seen.reasoning_effort).toBe("high")
    expect(seen.reasoning).toEqual({ effort: "high" })
    expect((seen.thinking as Record<string, unknown>).type).toBe("enabled")
    expect((seen.thinking as Record<string, unknown>).budget_tokens).toBe(1024)
  })
}

test("Responses injected image tool retains caller choice", async () => {
  const inv: Invocation = { endpoint: "responses", sourceApi: "responses", enabledFlags: new Set([flag, "responses-image-generation-inject"]), payload: { model: "m", input: [], tools: [], tool_choice: "auto" }, headers: {} }
  let seen: Record<string, unknown> = {}
  await runInterceptors(inv, ctx, responsesInterceptors, async () => { seen = { ...inv.payload }; return result() })
  expect(seen.tool_choice).toBe("auto")
  expect((seen.tools as unknown[]).length).toBe(1)
})

const searchRepo = {
  apiKeys: { getById: async () => ({
    id: "key_search", name: "search", key: "sk", createdAt: "2026-01-01T00:00:00Z",
    webSearchEnabled: true, modelMappingsEnabled: false, modelMappings: [],
    webSearchPriority: ["tavily"], webSearchTavilyKey: "test-key",
  }) },
  webSearchUsage: { record: async () => {} },
  webSearchEngineUsage: { record: async () => {} },
} as unknown as Repo

test("Chat hosted search injection retains caller choice when original tools is empty", async () => {
  initRepo(searchRepo)
  const inv: Invocation = {
    endpoint: "chat_completions", sourceApi: "chat_completions",
    enabledFlags: new Set([flag, "chat-completions-web-search-shim"]),
    payload: { model: "m", messages: [], tools: [], tool_choice: "auto", web_search_options: {} }, headers: {},
  }
  let seen: Record<string, unknown> = {}
  await runInterceptors(inv, { ...ctx, apiKeyId: "key_search" }, chatCompletionsInterceptors, async () => {
    seen = { ...inv.payload }
    return result()
  })
  expect(seen.tool_choice).toBe("auto")
  expect((seen.tools as unknown[]).length).toBe(1)
})

test("Messages native search preparation retains a usable tool and caller choice", async () => {
  initRepo(searchRepo)
  const inv: Invocation = {
    endpoint: "messages", sourceApi: "messages",
    enabledFlags: new Set([flag, "messages-web-search-shim"]),
    payload: { model: "m", max_tokens: 32, messages: [], tools: [{ type: "web_search_20250305", name: "web_search" }], tool_choice: { type: "auto" } },
    headers: {},
  }
  let seen: Record<string, unknown> = {}
  await runInterceptors(inv, { ...ctx, apiKeyId: "key_search" }, messagesInterceptors, async () => {
    seen = { ...inv.payload }
    return result()
  })
  expect(seen.tool_choice).toEqual({ type: "auto" })
  expect((seen.tools as unknown[]).length).toBeGreaterThan(0)
})
