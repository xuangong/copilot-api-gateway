import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import { BunSqliteDatabase } from "@vibe-llm/platform-bun/src/bun-sqlite-database.ts"
import { createBunResponsesStore } from "@vibe-llm/platform-bun/src/responses-store-factory.ts"
import { initUpstreamRepo } from "@vibe-core/upstream-repo"
import { __resetPlatformForTests, initBackground } from "@vibe-core/platform"
import { CodexProvider, CODEX_OAUTH_TOKEN_URL, encodeCodexResponsesLiteRequest, type Fetcher, type CodexUpstreamState } from "@vibe-llm/provider-codex"
import type { ProviderRequest } from "@vibe-llm/provider-llm"
import type { CanonicalResponsesPayload, ResponsesCompactionResult, ResponsesResult, ResponsesTool } from "@vibe-llm/protocols/responses"
import type { ApiKeyId } from "../src/repo/branded-ids.ts"
import { responsesAttempt } from "../src/data-plane/chat-flow/responses/attempt.ts"
import { respondResponses } from "../src/data-plane/chat-flow/responses/respond.ts"
import { createResponseSnapshotWriter } from "../src/data-plane/chat-flow/responses/completion-snapshot.ts"
import { expandPreviousResponseId } from "../src/data-plane/dispatch/responses-store-bridge.ts"
import { getTranslator } from "../src/data-plane/dispatch/translator-registry.ts"

const header = "x-openai-internal-codex-responses-lite"
const mirror = "ws_request_header_x_openai_internal_codex_responses_lite"
const key = "lite-test-key" as ApiKeyId
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); __resetPlatformForTests() })

interface Capture { url: string; headers: Headers; text: string; body: Record<string, unknown>; signal?: AbortSignal | null }
async function fixture(handler: (call: Capture, index: number) => Response | Promise<Response>, lite: boolean | null = true, accessOnly = false) {
  const directory = mkdtempSync(join(tmpdir(), "codex-lite-"))
  const db = new Database(join(directory, "test.sqlite"))
  const repo = new BunSqliteRepo(db)
  const state: CodexUpstreamState = { accounts: [{
    chatgptAccountId: "account", refresh_token: accessOnly ? null : "refresh-fixture", state: "active",
    state_updated_at: "2026-09-29", openaiDeviceId: "device-fixture", quotaSnapshot: null,
    accessToken: { token: "access-fixture", expiresAt: accessOnly ? null : Date.now() + 3600000, refreshedAt: "2026-09-29" },
  }] }
  await repo.upstreams.save({
    id: "lite-upstream", provider: "codex", name: "Lite fixture", enabled: true, sortOrder: 0,
    config: { accounts: [{ chatgptAccountId: "account", email: "fixture@example.test", chatgptUserId: "user", planType: "plus" }] },
    state, flagOverrides: {}, disabledPublicModelIds: [], proxyFallbackList: [], createdAt: "2026-09-29", updatedAt: "2026-09-29",
  })
  initUpstreamRepo(() => repo.upstreams)
  const pending: Promise<unknown>[] = []
  initBackground({ waitUntil: promise => { pending.push(promise) } })
  cleanup.push(async () => { await Promise.all(pending); db.close(); rmSync(directory, { recursive: true, force: true }) })
  const captures: Capture[] = []
  let refreshes = 0
  const fetcher: Fetcher = async (url, init) => {
    if (url === CODEX_OAUTH_TOKEN_URL) {
      refreshes++
      return Response.json({ access_token: "access-refreshed", refresh_token: "refresh-rotated", id_token: "fixture-id-token", expires_in: 3600 })
    }
    if (typeof init?.body !== "string") throw new Error("expected serialized JSON")
    const call = { url, text: init.body, body: JSON.parse(init.body) as Record<string, unknown>, headers: new Headers(init.headers), signal: init.signal }
    captures.push(call)
    return handler(call, captures.length)
  }
  const stored = await repo.upstreams.getById("lite-upstream")
  if (!stored) throw new Error("fixture row missing")
  const provider = new CodexProvider(stored, fetcher)
  provider.setModelCatalog({ object: "list", data: [{ id: "model", owned_by: "openai", kind: "chat", endpoints: { responses: {} }, ...(lite === null ? {} : { providerData: { useResponsesLite: lite } }) }] })
  return { provider, captures, store: createBunResponsesStore(new BunSqliteDatabase(db)), refreshes: () => refreshes }
}
const payload = (custom = false): CanonicalResponsesPayload => ({
  model: "model", input: [{ type: "message", role: "user", content: "你好 🌍" }], instructions: "fixture instructions",
  tools: [custom ? { type: "custom", name: "lookup", format: { type: "text" } } : { type: "function", name: "lookup", parameters: { type: "object" } }] as ResponsesTool[],
  client_metadata: { [mirror]: "malicious", keep: "retained" }, extension: { untouched: true },
})
const request = (body = payload(), action: "generate" | "compact" = "generate", signal?: AbortSignal): ProviderRequest => ({
  endpoint: "responses", sourceApi: "openai", sourceProtocol: "responses", payload: body, headers: new Headers({ [header]: "true" }), action, signal,
})
const wireResult = (id = "response-fixture"): ResponsesResult => ({
  id, object: "response", status: "completed", model: "model", error: null, incomplete_details: null,
  output: [{ type: "function_call", id: "same-item", call_id: "call-fixture", name: "lookup", namespace: "functions", arguments: "{}", status: "completed", extension: "output-kept" }],
  extension: "result-kept",
})
const sse = (events: unknown[]) => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } })

for (const lite of [null, false, true]) {
  test(`catalog ${String(lite)} alone selects Lite and strips client markers`, async () => {
    const f = await fixture(() => Response.json(wireResult()), lite)
    const body = payload()
    const before = structuredClone(body)
    const result = await f.provider.fetch(request(body))
    expect(body).toEqual(before)
    const call = f.captures[0]
    if (!call) throw new Error("missing call")
    expect(call.headers.get(header)).toBe(lite ? "true" : null)
    expect(call.body.client_metadata).toMatchObject({ keep: "retained" })
    expect(call.body.client_metadata).not.toHaveProperty(mirror)
    expect(call.body.extension).toEqual({ untouched: true })
    expect(call.body.tools === undefined).toBe(lite === true)
    expect(result.responsesAdapter !== undefined).toBe(lite === true)
    expect(result.headers.get("content-type")).toContain("application/json")
    await new Response(result.body).text()
  })
}
for (const action of ["generate", "compact"] as const) {
  test(`${action} Lite 401 retry reuses exact bytes and identity`, async () => {
    const f = await fixture((_call, n) => n === 1 ? Response.json({ error: { code: "expired" } }, { status: 401 }) : Response.json(wireResult()))
    const controller = new AbortController()
    const result = await f.provider.fetch(request(payload(), action, controller.signal))
    expect(f.captures).toHaveLength(2)
    const [first, second] = f.captures
    if (!first || !second) throw new Error("missing retry")
    expect(second.text).toBe(first.text)
    for (const name of [header, "session-id", "thread-id", "x-client-request-id", "x-codex-turn-metadata", "chatgpt-account-id", "content-type"]) expect(second.headers.get(name)).toBe(first.headers.get(name))
    expect(first.headers.get("authorization")).toBe("Bearer access-fixture")
    expect(second.headers.get("authorization")).toBe("Bearer access-refreshed")
    expect(second.signal).toBe(controller.signal)
    expect(first.url.endsWith(action === "compact" ? "/responses/compact" : "/responses")).toBe(true)
    expect(f.refreshes()).toBe(1)
    expect(action === "compact" ? result.compactAdapter : result.responsesAdapter).toBeDefined()
    await new Response(result.body).text()
  })
  for (const code of ["token_invalidated", "expired"]) {
    test(`${action} access-only ${code} never refreshes or retries`, async () => {
      const f = await fixture(() => Response.json({ error: { code } }, { status: 401 }), true, true)
      expect((await f.provider.fetch(request(payload(), action))).status).toBe(503)
      expect(f.captures).toHaveLength(1)
      expect(f.refreshes()).toBe(0)
    })
  }
}

async function gateway(f: Awaited<ReturnType<typeof fixture>>, body: CanonicalResponsesPayload, action: "generate" | "compact" = "generate", abort?: AbortController) {
  const translator = getTranslator("responses", "responses")
  if (!translator) throw new Error("missing translator")
  const attempt = await responsesAttempt.generate({
    payload: body, action, auth: {}, ctx: { requestStartedAt: Date.now(), downstreamAbortSignal: abort?.signal },
    telemetryCtx: { incomingModel: "model", userAgent: null, requestId: "fixture", isStreaming: body.stream === true, runtimeLocation: "bun", requestStartedAt: Date.now() },
    interceptors: [], selectBinding: async () => ({ kind: "ok", binding: { upstream: "lite-upstream", model: { id: "model" }, provider: f.provider }, targetEndpoint: "responses", translator, bareModel: "model" }),
  })
  return respondResponses(attempt, {
    wantsStream: body.stream === true, downstreamAbortController: abort, mergedInputItems: structuredClone(body.input),
    onCompleted: createResponseSnapshotWriter({ store: f.store, apiKeyId: key, retentionSeconds: 86400, fallbackModel: "model", compactTriggered: action === "compact" }),
  })
}
for (const stream of [false, true]) {
  test(`production ${stream ? "SSE" : "JSON"} restores output before SQLite and immediate continuation`, async () => {
    const f = await fixture(() => stream ? sse([{ type: "response.completed", response: wireResult() }]) : Response.json(wireResult()))
    const body = { ...payload(true), stream }
    const text = await (await gateway(f, body)).text()
    expect(text).toContain("custom_tool_call")
    expect(text).toContain("output-kept")
    expect(text).not.toContain('"namespace":"functions"')
    const saved = await f.store.load("response-fixture", key)
    expect(saved?.items).toEqual([...body.input, { type: "custom_tool_call", id: "same-item", call_id: "call-fixture", name: "lookup", input: "{}", status: "completed", extension: "output-kept" }])
    expect(await f.store.load("response-fixture", "other-owner")).toBeNull()
    const next = { ...payload(true), previous_response_id: "response-fixture" }
    await expandPreviousResponseId(next, f.store, key)
    expect(next.input).toEqual([...(saved?.items ?? []), ...body.input])
    expect(next.previous_response_id).toBeUndefined()
    f.provider.setModelCatalog({ object: "list", data: [{ id: "model", owned_by: "openai", kind: "chat", endpoints: { responses: {} } }] })
    await new Response((await f.provider.fetch(request(next))).body).text()
    expect(f.captures.at(-1)?.body.input).toEqual(next.input)
  })
}

test("compact encodes declarations before field selection and restores canonical continuation", async () => {
  const f = await fixture(call => Response.json({ id: "compact-fixture", object: "response.compaction", extension: "compact-kept", output: [...call.body.input as unknown[], { type: "compaction", id: "cmp", encrypted_content: "opaque" }, ...wireResult().output] }))
  const body = payload(true)
  const output = await (await gateway(f, body, "compact")).json() as Record<string, unknown>
  expect(output.extension).toBe("compact-kept")
  expect(f.captures[0]?.text).toContain("additional_tools")
  expect(f.captures[0]?.text).toContain("fixture instructions")
  expect(JSON.stringify(output)).not.toContain("model.base_instructions")
  expect(JSON.stringify(output)).not.toContain("additional_tools")
  expect(JSON.stringify(output)).toContain("custom_tool_call")
  const saved = await f.store.load("compact-fixture", key)
  expect(saved?.items).toEqual(output.output)
  const next = { input: [], previous_response_id: "compact-fixture" }
  await expandPreviousResponseId(next, f.store, key)
  expect(next.input).toEqual(output.output)
})

test("parallel calls with identical item IDs preserve opposite callable identities", async () => {
  const f = await fixture(() => sse([
    { type: "response.output_item.added", output_index: 0, item: wireResult().output[0] },
    { type: "response.function_call_arguments.delta", item_id: "same-item", output_index: 0, delta: "{}" },
    { type: "response.completed", response: wireResult() },
  ]))
  const results = await Promise.all([false, true].map(async custom => (await gateway(f, { ...payload(custom), stream: true })).text()))
  expect(results[0]).toContain("response.function_call_arguments.delta")
  expect(results[1]).toContain("response.custom_tool_call_input.delta")
})

for (const failure of ["error", "eof", "cancel"] as const) {
  test(`${failure} through production Lite parser creates no successful SQLite snapshot`, async () => {
    const f = await fixture(() => sse([
      { type: "response.created", response: { ...wireResult("unfinished"), status: "in_progress", output: [] } },
      ...(failure === "error" ? [{ type: "error", code: "upstream_error", message: "fixture" }] : []),
    ]))
    const abort = new AbortController()
    const response = await gateway(f, { ...payload(true), stream: true }, "generate", abort)
    if (failure === "cancel") { abort.abort(); await response.body?.cancel() }
    else await response.text()
    expect(await f.store.load("unfinished", key)).toBeNull()
  })
}

for (const action of ["generate", "compact"] as const) {
  test(`${action} renewable auth retry is bounded after a second 401`, async () => {
    const f = await fixture(() => Response.json({ error: { code: "expired" } }, { status: 401 }))
    const result = await f.provider.fetch(request(payload(), action))
    expect(result.status).toBe(401)
    expect(f.refreshes()).toBe(1)
    expect(f.captures).toHaveLength(2)
    expect(f.captures[1]?.text).toBe(f.captures[0]?.text)
  })
}

test("malformed catalog Lite metadata rejects before upstream dispatch", async () => {
  const f = await fixture(() => Response.json(wireResult()))
  f.provider.setModelCatalog({ object: "list", data: [{ id: "model", owned_by: "openai", kind: "chat", endpoints: { responses: {} }, providerData: { useResponsesLite: "true" } }] })
  await expect(f.provider.fetch(request())).rejects.toThrow("not a boolean")
  expect(f.captures).toHaveLength(0)
})

test("compact Standard strips injected Lite selectors while keeping canonical instructions", async () => {
  const f = await fixture(() => Response.json({ id: "standard-compact", object: "response.compaction", output: [] }), false)
  const result = await f.provider.fetch(request(payload(), "compact"))
  expect(f.captures[0]?.headers.get(header)).toBeNull()
  expect(f.captures[0]?.body.instructions).toBe("fixture instructions")
  expect(f.captures[0]?.text).not.toContain(mirror)
  expect(result.compactAdapter).toBeUndefined()
  await new Response(result.body).text()
})


test("compact inverse retains caller-owned duplicate prefixes and modified lookalikes", async () => {
  const original = payload(true)
  const encoded = encodeCodexResponsesLiteRequest({ ...original, input: original.input }, "fixed-thread")
  const prefix = encoded.body.input[1]
  if (!prefix) throw new Error("missing instruction prefix fixture")
  const modified = { ...prefix, content: "caller modified instructions" }
  const body = { ...original, input: [...original.input, prefix, modified] } as CanonicalResponsesPayload
  const before = structuredClone(body)
  const f = await fixture(call => Response.json({ id: "duplicate-prefix", object: "response.compaction", output: call.body.input }))
  const req = request(body, "compact")
  req.headers.set("thread-id", "fixed-thread")
  const response = await f.provider.fetch(req)
  const json = await new Response(response.body).json() as ResponsesCompactionResult
  const restored = response.compactAdapter?.(json)
  expect(restored?.output).toEqual(body.input)
  expect(body).toEqual(before)
})
