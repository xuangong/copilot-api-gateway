import { expect, test } from "bun:test"
import { borrowPrivatePayloadStore, createInMemoryPrivatePayloadStore, defaultPrivatePayloadStore } from "../../../../src/data-plane/orchestrator/server-tools/private-payload-store"
import { decodeWebSearchPrivatePayload, type WebSearchCallPrivatePayload } from "../../../../src/data-plane/orchestrator/server-tools/private-payload"

const payload: WebSearchCallPrivatePayload = { v: 1, functionCallItem: { type: "function_call", call_id: "call", name: "search", arguments: "{}", extension: true }, ir: { action: { type: "search", queries: ["q"], sources: [{ type: "url", url: "https://example.test" }] }, results: [{ type: "text_result", url: "https://example.test", title: "title", snippet: "text" }], outputText: "model output" } }

test("owned scopes borrow typed references, isolate ids, and revoke every capability on dispose", () => {
  const a = defaultPrivatePayloadStore.createScope()
  const b = defaultPrivatePayloadStore.createScope()
  expect(Object.keys(a.reader)).toEqual(["getPrivatePayload"])
  expect(Object.keys(a.writer)).toEqual(["registerPrivatePayload"])
  expect(a.writer.registerPrivatePayload("same", payload)).toBeUndefined()
  expect(a.reader.getPrivatePayload("same")).toBe(payload)
  expect(b.reader.getPrivatePayload("same")).toBeUndefined()
  b.writer.registerPrivatePayload("same", payload)
  expect(a.dispose()).toBeUndefined()
  expect(a.dispose()).toBeUndefined()
  expect(a.reader.getPrivatePayload("same")).toBeUndefined()
  expect(() => a.writer.registerPrivatePayload("new", payload)).toThrow("closed")
  expect(b.reader.getPrivatePayload("same")).toBe(payload)
  b.dispose()
})

test("borrowed adapter validates foreign data but never clears the external legacy store", () => {
  const store = createInMemoryPrivatePayloadStore()
  const adapter = borrowPrivatePayloadStore(store)
  store.registerPrivatePayload("valid", payload)
  store.registerPrivatePayload("invalid", { secret: 42 })
  expect(adapter.reader.getPrivatePayload("valid")).toBe(payload)
  expect(adapter.reader.getPrivatePayload("invalid")).toBeUndefined()
  adapter.dispose()
  expect(adapter.reader.getPrivatePayload("valid")).toBeUndefined()
  expect(() => adapter.writer.registerPrivatePayload("new", payload)).toThrow("closed")
  expect(store.getPrivatePayload("valid")).toBe(payload)
  expect(store.getPrivatePayload("invalid")).toEqual({ secret: 42 })
})

test("foreign decoder accepts every existing action and keeps borrowed reference identity", () => {
  for (const action of [payload.ir.action, { type: "search" }, { type: "open_page" }, { type: "open_page", url: "https://example.test" }, { type: "find_in_page", url: "https://example.test", pattern: "text" }] as const) {
    const value = { ...payload, ir: { ...payload.ir, action } }
    expect(decodeWebSearchPrivatePayload(value)).toBe(value)
  }
})

test("foreign decoder rejects malformed consumed function, action, result and output fields", () => {
  const malformed: unknown[] = [null, [], "payload", { ...payload, v: 2 }, { ...payload, functionCallItem: null }, ...["call_id", "name", "arguments", "status"].map(key => ({ ...payload, functionCallItem: { ...payload.functionCallItem, [key]: 42 } })),
    ...[{ type: "other" }, { type: "search", query: 1 }, { type: "search", queries: [1] }, { type: "search", sources: [{ type: "url" }] }, { type: "open_page", url: 42 }, { type: "find_in_page", url: "url" }].map(action => ({ ...payload, ir: { ...payload.ir, action } })),
    ...[undefined, {}, [null], [{ type: "text_result", url: "u", title: "t" }], [{ type: "text_result", url: "u", title: "t", snippet: 1 }]].map(results => ({ ...payload, ir: { ...payload.ir, results } })), { ...payload, ir: { ...payload.ir, outputText: false } }]
  for (const value of malformed) expect(decodeWebSearchPrivatePayload(value)).toBeUndefined()
})

test("malformed foreign replay uses the existing missing-private-payload fallback", async () => {
  const { transformInputItemsForWebSearch } = await import("../../../../src/data-plane/chat-flow/responses/interceptors/server-tools/web-search")
  const store = createInMemoryPrivatePayloadStore()
  store.registerPrivatePayload("ws", { ...payload, ir: { action: { type: "search", query: "q" }, results: [null] } })
  const scope = borrowPrivatePayloadStore(store)
  const items = transformInputItemsForWebSearch([{ id: "ws", type: "web_search_call", action: { type: "search", query: "q" } }], "web_search", scope.reader.getPrivatePayload)
  expect(items[0]).toMatchObject({ type: "function_call", name: "web_search", arguments: '{"search_query":[{"q":"q"}]}' })
  expect(items[1]).toMatchObject({ type: "function_call_output", output: "Prior search results were not preserved in the conversation history. Call web_search again if you need them." })
  scope.dispose()
})

for (const field of ["results", "queries", "sources"] as const) test(`sparse foreign ${field} is rejected and borrowed replay falls back`, async () => {
  const { transformInputItemsForWebSearch } = await import("../../../../src/data-plane/chat-flow/responses/interceptors/server-tools/web-search")
  const sparse = new Array<unknown>(1)
  const ir = field === "results"
    ? { action: { type: "open_page", url: "https://example.test" }, results: sparse }
    : { action: { type: "search", query: "q", [field]: sparse }, results: payload.ir.results }
  const value = { ...payload, ir }
  expect(decodeWebSearchPrivatePayload(value)).toBeUndefined()
  const store = createInMemoryPrivatePayloadStore()
  store.registerPrivatePayload("sparse", value)
  const scope = borrowPrivatePayloadStore(store)
  expect(scope.reader.getPrivatePayload("sparse")).toBeUndefined()
  const items = transformInputItemsForWebSearch([{ id: "sparse", type: "web_search_call", action: { type: "search", query: "q" } }], "web_search", scope.reader.getPrivatePayload)
  expect(items[1]).toMatchObject({ type: "function_call_output", output: "Prior search results were not preserved in the conversation history. Call web_search again if you need them." })
  expect(store.getPrivatePayload("sparse")).toBe(value)
  scope.dispose()
})
