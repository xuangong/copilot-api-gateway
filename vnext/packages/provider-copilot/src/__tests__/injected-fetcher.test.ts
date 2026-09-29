import { test, expect } from "bun:test"
import { CopilotProvider } from "../provider"
import { copilotProviderPlugin } from "../plugin"
import { clearRawModelsCache } from "../raw-models-cache"
import type { Fetcher } from "@vibe-core/upstream"
import type { UpstreamRecord } from "@vibe-llm/protocols/common"

interface SeenCall { url: string; method: string; hasAuth: boolean }

const MODELS_BODY = {
  object: "list",
  data: [
    {
      id: "claude-sonnet-4-5",
      name: "Claude Sonnet 4.5",
      object: "model",
      vendor: "Anthropic",
      version: "1",
      preview: false,
      model_picker_enabled: true,
      capabilities: { family: "claude", limits: {}, object: "model_capabilities", supports: {}, tokenizer: "o200k", type: "chat" },
    },
  ],
}

/** `headers` may be a plain object or a Headers instance depending on the call site. */
const readAuth = (headers: RequestInit["headers"]): boolean =>
  headers instanceof Headers
    ? headers.has("authorization")
    : Boolean((headers as Record<string, string> | undefined)?.Authorization)

/** Records every call and answers /models and /v1/messages with plausible bodies. */
const recordingFetcher = (seen: SeenCall[]): Fetcher => async (url, init) => {
  seen.push({
    url,
    method: (init.method as string) ?? "GET",
    hasAuth: readAuth(init.headers),
  })
  const body = url.endsWith("/models")
    ? MODELS_BODY
    : { id: "msg_1", type: "message", role: "assistant", content: [] }
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

test("CopilotProvider uses injected fetcher instead of global fetch", async () => {
  clearRawModelsCache()
  const seen: SeenCall[] = []

  const provider = new CopilotProvider(
    { copilotToken: "tok_inference", accountType: "individual" },
    recordingFetcher(seen),
  )

  const resp = await provider.fetch({
    endpoint: "messages",
    sourceApi: "anthropic",
    headers: new Headers(),
    payload: { model: "claude-sonnet-4-5", messages: [{ role: "user", content: "hi" }], max_tokens: 8 },
  })

  expect(resp.status).toBe(200)
  // Two hops, both through the injected fetcher: the variant interceptor's raw
  // model-list lookup (claude-* models only), then the inference call itself.
  const messages = seen.filter((c) => c.url.includes("/v1/messages"))
  expect(messages.length).toBe(1)
  expect(messages[0]!.method).toBe("POST")
  expect(messages[0]!.hasAuth).toBe(true)
  expect(seen.some((c) => c.url.endsWith("/models"))).toBe(true)
})

test("variant discovery and auth refresh stay ordinary across terminal 401 retry", async () => {
  clearRawModelsCache()
  const ordinary: SeenCall[] = []
  const terminal: SeenCall[] = []
  let calls = 0
  const terminalFetcher: Fetcher = async (url, init) => {
    terminal.push({ url, method: init.method ?? "GET", hasAuth: readAuth(init.headers) })
    calls++
    return calls === 1
      ? new Response('{"error":"unauthorized"}', { status: 401 })
      : new Response('{"id":"msg_1","type":"message","role":"assistant","content":[]}', { status: 200, headers: { "content-type": "application/json" } })
  }
  let refreshes = 0
  const selected: string[] = []
  const provider = new CopilotProvider({
    copilotToken: "stale", accountType: "individual",
    refreshSession: async () => { refreshes++; return { token: "fresh" } },
  }, recordingFetcher(ordinary), request => {
    selected.push(request.endpoint)
    return terminalFetcher
  })
  const result = await provider.fetch({
    endpoint: "messages", sourceApi: "anthropic", headers: new Headers(),
    payload: { model: "claude-sonnet-4-5", messages: [{ role: "user", content: "hi" }], max_tokens: 8 },
  })
  expect(result.status).toBe(200)
  expect(ordinary.map(call => call.url)).toEqual(["https://api.githubcopilot.com/models"])
  expect(terminal).toHaveLength(2)
  expect(refreshes).toBe(1)
  expect(selected).toEqual(["messages", "messages"])
})

test("plugin token exchange uses ordinary egress while both application sends use execution egress", async () => {
  clearRawModelsCache()
  const ordinary: SeenCall[] = []
  const terminal: SeenCall[] = []
  const ordinaryFetcher = recordingFetcher(ordinary)
  let sends = 0
  let exchanges = 0
  const upstream: UpstreamRecord = {
    id: "copilot_test", provider: "copilot", name: "copilot", enabled: true, sortOrder: 0,
    config: { githubToken: "github-token", accountType: "individual" }, state: null,
    flagOverrides: {}, disabledPublicModelIds: [], proxyFallbackList: [],
    createdAt: "2026-01-01", updatedAt: "2026-01-01",
  }
  const provider = await copilotProviderPlugin.createFromUpstream(upstream, {
    deferCredentials: true,
    fetcherForUpstream: () => ordinaryFetcher,
    getCachedCopilotToken: async (_token, _type, _host, fetcher, options) => {
      expect(fetcher).toBe(ordinaryFetcher)
      await fetcher?.("https://github.test/session", { method: "POST" })
      exchanges++
      return { token: options?.forceRefresh ? "fresh" : "stale", apiEndpoint: "https://api.githubcopilot.com" }
    },
    executionFetcherForUpstream: () => async (url, init) => {
      terminal.push({ url, method: init.method ?? "GET", hasAuth: readAuth(init.headers) })
      sends++
      return sends === 1
        ? new Response('{"error":"unauthorized"}', { status: 401 })
        : Response.json({ id: "msg_1", type: "message", role: "assistant", content: [] })
    },
  })
  expect(provider).not.toBeNull()
  expect((await provider?.fetch({
    endpoint: "messages", sourceApi: "anthropic", headers: new Headers(),
    payload: { model: "claude-sonnet-4-5", messages: [{ role: "user", content: "hi" }], max_tokens: 8 },
  }))?.status).toBe(200)
  expect(exchanges).toBe(2)
  expect(ordinary.filter(call => call.url === "https://github.test/session")).toHaveLength(2)
  expect(ordinary.filter(call => call.url.endsWith("/models"))).toHaveLength(1)
  expect(terminal).toHaveLength(2)
})

test("variant resolution's raw model-list lookup goes through the injected fetcher", async () => {
  clearRawModelsCache()
  const seen: SeenCall[] = []

  const provider = new CopilotProvider(
    { copilotToken: "tok_variants", accountType: "individual" },
    recordingFetcher(seen),
  )

  await provider.fetch({
    endpoint: "messages",
    sourceApi: "anthropic",
    headers: new Headers({ "anthropic-beta": "context-1m-2025-08-07" }),
    payload: { model: "claude-sonnet-4-5", messages: [{ role: "user", content: "hi" }], max_tokens: 8 },
  })

  const modelsCalls = seen.filter((c) => c.url.endsWith("/models"))
  expect(modelsCalls.length).toBe(1)
  expect(modelsCalls[0]!.hasAuth).toBe(true)
})

test("getModels() goes through the injected fetcher, not global fetch", async () => {
  const seen: SeenCall[] = []

  const provider = new CopilotProvider(
    { copilotToken: "tok_models", accountType: "individual" },
    recordingFetcher(seen),
  )

  const models = await provider.getModels()

  expect(seen.length).toBe(1)
  expect(seen[0]!.url).toBe("https://api.githubcopilot.com/models")
  expect(seen[0]!.hasAuth).toBe(true)
  expect(models.data[0]!.id).toBe("claude-sonnet-4-5")
})

test("getModels() honours the baseUrl override while still using the injected fetcher", async () => {
  const seen: SeenCall[] = []

  const provider = new CopilotProvider(
    { copilotToken: "tok_ghe", accountType: "individual", baseUrl: "https://copilot-api.msft.ghe.com" },
    recordingFetcher(seen),
  )

  await provider.getModels()

  expect(seen[0]!.url).toBe("https://copilot-api.msft.ghe.com/models")
})

test("probe() reaches upstream through the injected fetcher", async () => {
  const seen: SeenCall[] = []

  const provider = new CopilotProvider(
    { copilotToken: "tok_probe", accountType: "individual" },
    recordingFetcher(seen),
  )

  const result = await provider.probe()

  expect(result.ok).toBe(true)
  expect(seen.length).toBe(1)
  expect(seen[0]!.url).toBe("https://api.githubcopilot.com/models")
})

test("probe() surfaces a fetcher failure instead of falling back to direct egress", async () => {
  const failing: Fetcher = async () => { throw new Error("proxy CONNECT refused") }

  const provider = new CopilotProvider(
    { copilotToken: "tok_fail", accountType: "individual" },
    failing,
  )

  const result = await provider.probe()

  expect(result.ok).toBe(false)
})
