import { expect, test } from "bun:test"
import { eventFrame, type ProtocolFrame } from "@vibe-core/result"
import { llmEventResult, type Invocation, type LlmEventResult } from "@vibe-llm/protocols/common"
import type { ResponsesResult, ResponsesStreamEvent } from "@vibe-llm/protocols/responses"
import { withResponsesServerToolShim } from "../../../../../src/data-plane/chat-flow/responses/interceptors/server-tool-shim"
import { defaultPrivatePayloadStore, createInMemoryPrivatePayloadStore } from "../../../../../src/data-plane/orchestrator/server-tools/private-payload-store"
import type { ServerToolRegistration, ServerToolRequestCtx, ServerToolResultSlot } from "../../../../../src/data-plane/orchestrator/server-tools/types"
import { webSearchServerTool, type WebSearchCallPrivatePayload } from "../../../../../src/data-plane/chat-flow/responses/interceptors/server-tools/web-search"
import { setupTestPlatform } from "../../../../_setup-platform"
import type { ApiKeyId } from "../../../../../src/repo/branded-ids"

const identity = { incomingModel: "m", model: "m", modelKey: "m", upstream: "up", cost: null }
const invocation = (): Invocation => ({ endpoint: "responses", sourceApi: "chat_completions", enabledFlags: new Set(["responses-web-search-shim"]), headers: {}, payload: { model: "m", stream: true, input: [], tools: [{ type: "web_search" }] } })
const payload: WebSearchCallPrivatePayload = { v: 1, functionCallItem: { type: "function_call", call_id: "call", name: "web_search", arguments: "{}" }, ir: { action: { type: "search", query: "q" }, results: [{ type: "text_result", url: "https://example.test", title: "title", snippet: "private result" }] } }
const snapshot = (): ResponsesResult => ({ id: "response", object: "response", model: "m", output: [], status: "completed", error: null, incomplete_details: null }) as ResponsesResult
function frames(call?: string): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {
  return (async function* () {
    const response = snapshot()
    yield eventFrame({ type: "response.created", response })
    if (call) {
      const item = { id: `fc_${call}`, type: "function_call" as const, call_id: call, name: "web_search", arguments: JSON.stringify({ search_query: [{ q: call }] }), status: "completed" }
      yield eventFrame({ type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } })
      yield eventFrame({ type: "response.output_item.done", output_index: 0, item })
    }
    yield eventFrame({ type: "response.completed", response })
  })()
}
function registration(observe: (ctx: ServerToolRequestCtx) => void = () => {}, slot?: ServerToolResultSlot): ServerToolRegistration<Invocation, ServerToolRequestCtx> {
  return (_inv, ctx) => {
    observe(ctx)
    return { type: "active", baseToolName: "web_search", hosted: {
      hostedTypes: ["web_search"], canonicalize: raw => raw.type === "web_search" ? raw : undefined,
      buildFunctionTool: (_tool, name) => ({ type: "function", name }),
      dispatcher: () => [slot ?? { id: "ws_shared", startItem: { type: "web_search_call", status: "in_progress" }, startEvents: [], run: async function* () { yield* []; return { item: { type: "web_search_call", status: "completed" }, endEvents: [], privatePayload: payload } } }],
    } }
  }
}
async function drain(result: LlmEventResult<ProtocolFrame<ResponsesStreamEvent>>): Promise<ResponsesStreamEvent[]> {
  const output: ResponsesStreamEvent[] = []
  for await (const frame of result.events) if (frame.type === "event") output.push(frame.event)
  return output
}
function requireEvents(result: Awaited<ReturnType<ReturnType<typeof withResponsesServerToolShim>>>): LlmEventResult<ProtocolFrame<ResponsesStreamEvent>> {
  if (result.type !== "events") throw new Error("Expected events")
  return result
}
async function settles<T>(promise: Promise<T>): Promise<T | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([promise, new Promise<"timeout">(resolve => { timer = setTimeout(() => resolve("timeout"), 100) })]) }
  finally { if (timer !== undefined) clearTimeout(timer) }
}

test("default hosted invocations do not share private item ids after drain", async () => {
  let reader: ServerToolRequestCtx["store"] | undefined
  const shim = withResponsesServerToolShim([registration(ctx => { reader = ctx.store })], defaultPrivatePayloadStore)
  let calls = 0
  await drain(requireEvents(await shim(invocation(), { requestStartedAt: 0 }, async () => llmEventResult(frames(++calls === 1 ? "first" : undefined), identity))))
  expect(reader?.getPrivatePayload("ws_shared")).toBeUndefined()
  const second = requireEvents(await shim(invocation(), { requestStartedAt: 0 }, async () => llmEventResult(frames(), identity)))
  expect(reader?.getPrivatePayload("ws_shared")).toBeUndefined()
  await drain(second)
})

test("borrowed storage survives closure while the captured plugin reader is closed", async () => {
  const store = createInMemoryPrivatePayloadStore()
  let reader: ServerToolRequestCtx["store"] | undefined
  let calls = 0
  const result = requireEvents(await withResponsesServerToolShim([registration(ctx => { reader = ctx.store })], store)(invocation(), { requestStartedAt: 0 }, async () => llmEventResult(frames(++calls === 1 ? "first" : undefined), identity)))
  await drain(result)
  expect(store.getPrivatePayload("ws_shared")).toBe(payload)
  expect(reader?.getPrivatePayload("ws_shared")).toBeUndefined()
  expect(Object.keys(reader ?? {})).toEqual(["getPrivatePayload"])
})

for (const exit of ["return", "throw", "discard", "abort"] as const) test(`unstarted hosted ${exit} closes the concrete producer and settles metadata`, async () => {
  let returned = 0
  let disposed = 0
  let read = 0
  const controller = new AbortController()
  const upstream = { ...llmEventResult({ [Symbol.asyncIterator]: () => ({
    next: async () => { read++; return { done: true as const, value: undefined } },
    return: async () => { returned++; return { done: true as const, value: undefined } },
  }) }, identity), discardProducer: async () => { disposed++ } }
  const result = requireEvents(await withResponsesServerToolShim([registration()], defaultPrivatePayloadStore)(invocation(), { requestStartedAt: 0, downstreamAbortSignal: controller.signal }, async () => upstream))
  const iterator = result.events[Symbol.asyncIterator]()
  if (exit === "return") await iterator.return?.()
  if (exit === "throw") await iterator.throw?.(new Error("consumer stopped")).catch(() => {})
  if (exit === "discard") await result.discardProducer?.()
  if (exit === "abort") { controller.abort(); await result.discardProducer?.() }
  expect(read).toBe(0)
  expect(returned).toBe(1)
  expect(disposed).toBe(1)
  expect(await settles(result.finalMetadata ?? Promise.reject(new Error("Missing metadata")))).toEqual({ modelIdentity: identity, performance: undefined })
})

for (const sourceApi of ["chat_completions", "messages", "gemini"] as const) test(`real ${sourceApi} search keeps both private results through two hosted turns without include`, async () => {
  const { db, repo } = setupTestPlatform()
  const originalFetch = globalThis.fetch
  try {
    await repo.apiKeys.save({ id: "private-search-key" as ApiKeyId, name: "private search", key: "sk-private-search", createdAt: "2026-01-01T00:00:00Z", webSearchEnabled: true, modelMappingsEnabled: false, modelMappings: [], webSearchPriority: ["tavily"], webSearchTavilyKey: "fixture" })
    globalThis.fetch = (async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { query: string }
      return Response.json({ results: [{ url: "https://example.test", title: body.query, content: `private-${body.query}` }] })
    }) as typeof fetch
    const inv = { ...invocation(), sourceApi }
    const inputs: unknown[] = []
    let calls = 0
    const result = requireEvents(await withResponsesServerToolShim([webSearchServerTool], defaultPrivatePayloadStore)(inv, { requestStartedAt: 0, apiKeyId: "private-search-key" }, async () => {
      inputs.push(structuredClone(inv.payload.input))
      return llmEventResult(frames(++calls <= 2 ? `query${calls}` : undefined), identity)
    }))
    const output = await drain(result)
    expect(calls).toBe(3)
    expect(JSON.stringify(inputs[1])).toContain("private-query1")
    expect(JSON.stringify(inputs[2])).toContain("private-query1")
    expect(JSON.stringify(inputs[2])).toContain("private-query2")
    const completed = output.find(event => event.type === "response.completed")
    if (completed?.type !== "response.completed") throw new Error("Missing terminal")
    const searches = completed.response.output.filter(item => item.type === "web_search_call")
    expect(searches).toHaveLength(2)
    expect(searches.every(item => !("results" in item))).toBe(true)
  } finally { globalThis.fetch = originalFetch; db.close() }
})

for (const active of [false, true]) test(`${active ? "replay-only" : "inactive"} default invocation allocates no scope or abort listener and preserves result identity`, async () => {
  let scopes = 0
  let listeners = 0
  const signal = new AbortController().signal
  const add = signal.addEventListener.bind(signal)
  signal.addEventListener = (...args: Parameters<typeof signal.addEventListener>) => { listeners++; return add(...args) }
  const source = { ownership: "owned" as const, createScope() { scopes++; return defaultPrivatePayloadStore.createScope() } }
  const upstream = llmEventResult(frames(), identity)
  const result = await withResponsesServerToolShim([(_inv, ctx) => active ? { type: "active", baseToolName: "replay", transformItems: items => { expect(ctx.store.getPrivatePayload("ws_shared")).toBeUndefined(); return items } } : { type: "inactive" }], source)(invocation(), { requestStartedAt: 0, downstreamAbortSignal: signal }, async () => upstream)
  expect(result).toBe(upstream)
  expect(scopes).toBe(0)
  expect(listeners).toBe(0)
})

test("replay-only explicit store hydrates foreign private history and closes only its reader", async () => {
  const { transformInputItemsForWebSearch } = await import("../../../../../src/data-plane/chat-flow/responses/interceptors/server-tools/web-search")
  const store = createInMemoryPrivatePayloadStore()
  store.registerPrivatePayload("ws_shared", payload)
  let reader: ServerToolRequestCtx["store"] | undefined
  const inv = invocation()
  inv.payload.input = [{ type: "web_search_call", id: "ws_shared", action: payload.ir.action }]
  const upstream = llmEventResult(frames(), identity)
  const result = await withResponsesServerToolShim([(_inv, ctx) => { reader = ctx.store; return { type: "active", baseToolName: "web_search", transformItems: (items, name) => transformInputItemsForWebSearch(items, name, ctx.store.getPrivatePayload) } }], store)(inv, { requestStartedAt: 0 }, async () => upstream)
  expect(result).toBe(upstream)
  expect(JSON.stringify(inv.payload.input)).toContain("private result")
  expect(reader?.getPrivatePayload("ws_shared")).toBeUndefined()
  expect(store.getPrivatePayload("ws_shared")).toBe(payload)
})

test("slots without private payload never write undefined into borrowed storage", async () => {
  const writes: unknown[] = []
  let calls = 0
  const slot: ServerToolResultSlot = { id: "image", startItem: { type: "image_generation_call", status: "in_progress" }, startEvents: [], run: async function* () { yield* []; return { item: { type: "image_generation_call", status: "completed" }, endEvents: [] } } }
  await drain(requireEvents(await withResponsesServerToolShim([registration(undefined, slot)], { getPrivatePayload: () => undefined, registerPrivatePayload: (_id, value) => { writes.push(value) } })(invocation(), { requestStartedAt: 0 }, async () => llmEventResult(frames(++calls === 1 ? "first" : undefined), identity))))
  expect(writes).toEqual([])
})

for (const status of ["failed", "incomplete"] as const) test(`natural ${status} closes captured private reader and keeps the upstream terminal`, async () => {
  let reader: ServerToolRequestCtx["store"] | undefined
  const source = (async function* () { yield eventFrame({ type: "response.created", response: snapshot() }); yield eventFrame({ type: `response.${status}` as const, response: { ...snapshot(), status, error: status === "failed" ? { code: "original", message: "original failure" } : null, incomplete_details: status === "incomplete" ? { reason: "max_output_tokens" } : null } }) })()
  const result = requireEvents(await withResponsesServerToolShim([registration(ctx => { reader = ctx.store })], defaultPrivatePayloadStore)(invocation(), { requestStartedAt: 0 }, async () => llmEventResult(source, identity)))
  const output = await drain(result)
  expect(output.at(-1)?.type).toBe(`response.${status}`)
  expect(reader?.getPrivatePayload("ws_shared")).toBeUndefined()
  expect(await settles(result.finalMetadata ?? Promise.reject(new Error("Missing metadata")))).not.toBe("timeout")
})

for (const exit of ["return", "abort"] as const) test(`pending slot ${exit} closes immediately and late completion cannot register or rerun`, async () => {
  const started = Promise.withResolvers<void>()
  const terminal = Promise.withResolvers<import("../../../../../src/data-plane/orchestrator/server-tools/types").ServerToolTerminal>()
  const writes: unknown[] = []
  let returned = 0
  let calls = 0
  const slot: ServerToolResultSlot = { id: "pending", startItem: { type: "web_search_call", status: "in_progress" }, startEvents: [], run: () => ({
    [Symbol.asyncIterator]() { return this }, [Symbol.asyncDispose]: async () => {},
    next: async () => { started.resolve(); return { done: true, value: await terminal.promise } },
    return: async value => { returned++; return { done: true, value } },
    throw: async error => { throw error },
  }) }
  const controller = new AbortController()
  const result = requireEvents(await withResponsesServerToolShim([registration(undefined, slot)], { getPrivatePayload: () => undefined, registerPrivatePayload: (_id, value) => { writes.push(value) } })(invocation(), { requestStartedAt: 0, downstreamAbortSignal: controller.signal }, async () => { calls++; return llmEventResult(frames("first"), identity) }))
  const running = drain(result).catch(error => error)
  await started.promise
  if (exit === "abort") controller.abort()
  else await result.events[Symbol.asyncIterator]().return?.()
  await result.discardProducer?.()
  terminal.resolve({ item: { type: "web_search_call", status: "completed" }, endEvents: [], privatePayload: payload })
  await running
  expect(returned).toBe(1)
  expect(writes).toEqual([])
  expect(calls).toBe(1)
})

for (const timing of ["after-close", "same-tick"] as const) test(`later provider ${timing} resolution is disposed without another pull or turn`, async () => {
  const pending = Promise.withResolvers<LlmEventResult<ProtocolFrame<ResponsesStreamEvent>>>()
  const started = Promise.withResolvers<void>()
  const controller = new AbortController()
  let calls = 0
  let returned = 0
  let disposed = 0
  let reads = 0
  const late = { ...llmEventResult({ [Symbol.asyncIterator]: () => ({ next: async () => { reads++; return { done: true as const, value: undefined } }, return: async () => { returned++; return { done: true as const, value: undefined } } }) }, identity), discardProducer: async () => { disposed++ } }
  const result = requireEvents(await withResponsesServerToolShim([registration()], defaultPrivatePayloadStore)(invocation(), { requestStartedAt: 0, downstreamAbortSignal: controller.signal }, async () => { if (++calls === 1) return llmEventResult(frames("first"), identity); started.resolve(); return pending.promise }))
  const running = drain(result).catch(error => error)
  await started.promise
  if (timing === "same-tick") { pending.resolve(late); queueMicrotask(() => controller.abort()) }
  else { controller.abort(); pending.resolve(late) }
  await running
  await result.discardProducer?.()
  expect(returned).toBe(1)
  expect(disposed).toBe(1)
  expect(reads).toBe(0)
  expect(calls).toBe(2)
  expect(await settles(result.finalMetadata ?? Promise.reject(new Error("Missing metadata")))).not.toBe("timeout")
})

test("concurrent default invocations keep equal private ids independent until their own close", async () => {
  const readers: ServerToolRequestCtx["store"][] = []
  const startedA = Promise.withResolvers<void>()
  const startedB = Promise.withResolvers<void>()
  const finishA = Promise.withResolvers<LlmEventResult<ProtocolFrame<ResponsesStreamEvent>>>()
  const finishB = Promise.withResolvers<LlmEventResult<ProtocolFrame<ResponsesStreamEvent>>>()
  const shim = withResponsesServerToolShim([registration(ctx => readers.push(ctx.store))], defaultPrivatePayloadStore)
  let callsA = 0
  let callsB = 0
  const a = requireEvents(await shim(invocation(), { requestStartedAt: 0 }, async () => { if (++callsA === 1) return llmEventResult(frames("a"), identity); startedA.resolve(); return finishA.promise }))
  const b = requireEvents(await shim(invocation(), { requestStartedAt: 0 }, async () => { if (++callsB === 1) return llmEventResult(frames("b"), identity); startedB.resolve(); return finishB.promise }))
  const drainA = drain(a)
  const drainB = drain(b)
  await Promise.all([startedA.promise, startedB.promise])
  expect(readers[0]?.getPrivatePayload("ws_shared")).toBe(payload)
  expect(readers[1]?.getPrivatePayload("ws_shared")).toBe(payload)
  finishA.resolve(llmEventResult(frames(), identity))
  await drainA
  expect(readers[0]?.getPrivatePayload("ws_shared")).toBeUndefined()
  expect(readers[1]?.getPrivatePayload("ws_shared")).toBe(payload)
  finishB.resolve(llmEventResult(frames(), identity))
  await drainB
  expect(readers[1]?.getPrivatePayload("ws_shared")).toBeUndefined()
})

test("abort closes the current later producer, revokes state synchronously and ignores its late next", async () => {
  let reader: ServerToolRequestCtx["store"] | undefined
  let calls = 0
  let returned = 0
  let disposed = 0
  const controller = new AbortController()
  const started = Promise.withResolvers<void>()
  const pending = Promise.withResolvers<IteratorResult<ProtocolFrame<ResponsesStreamEvent>>>()
  const later = { ...llmEventResult({ [Symbol.asyncIterator]: () => ({ next: () => { started.resolve(); return pending.promise }, return: async () => { returned++; return { done: true as const, value: undefined } } }) }, identity), discardProducer: async () => { disposed++ } }
  const result = requireEvents(await withResponsesServerToolShim([registration(ctx => { reader = ctx.store })], defaultPrivatePayloadStore)(invocation(), { requestStartedAt: 0, downstreamAbortSignal: controller.signal }, async () => ++calls === 1 ? llmEventResult(frames("first"), identity) : later))
  const running = drain(result).catch(error => error)
  await started.promise
  expect(reader?.getPrivatePayload("ws_shared")).toBe(payload)
  controller.abort()
  expect(reader?.getPrivatePayload("ws_shared")).toBeUndefined()
  await running
  await result.discardProducer?.()
  pending.resolve({ done: false, value: eventFrame({ type: "response.completed", response: snapshot() }) })
  expect(returned).toBe(1)
  expect(disposed).toBe(1)
  expect(calls).toBe(2)
})

for (const failure of ["reject", "hang"] as const) test(`slot ${failure} cleanup remains false through later successful outer cleanup and turn facts`, async () => {
  const { createResponsesTurn } = await import("../../../../../src/data-plane/chat-flow/responses/turn")
  const { db } = setupTestPlatform()
  let returned = 0
  const slot: ServerToolResultSlot = { id: "failure", startItem: { type: "web_search_call", status: "in_progress" }, startEvents: [], run: () => ({
    [Symbol.asyncIterator]() { return this }, [Symbol.asyncDispose]: async () => {},
    next: async () => { throw new Error("original slot failure") },
    return: async () => { returned++; if (failure === "reject") throw new Error("cleanup failure"); return new Promise(() => {}) },
    throw: async error => { throw error },
  }) }
  try {
    const result = requireEvents(await withResponsesServerToolShim([registration(undefined, slot)], defaultPrivatePayloadStore)(invocation(), { requestStartedAt: 0 }, async () => llmEventResult(frames("first"), identity)))
    const turn = createResponsesTurn(result, { wantsStream: true })
    const output: ResponsesStreamEvent[] = []
    for await (const event of turn.events) output.push(event)
    expect(JSON.stringify(output)).toContain("original slot failure")
    expect(JSON.stringify(output)).not.toContain("cleanup failure")
    expect(await turn.facts).toMatchObject({ rawCleanupComplete: false })
    expect((await turn.completion).cleanupComplete).toBe(false)
    await expect(result.discardProducer?.()).rejects.toThrow("cleanup incomplete")
    expect(returned).toBe(1)
    expect(await settles(result.finalMetadata ?? Promise.reject(new Error("Missing metadata")))).not.toBe("timeout")
  } finally { db.close() }
})

test("throwing owned disposal revokes the reader and still closes upstream resources", async () => {
  let reader: ServerToolRequestCtx["store"] | undefined
  let returned = 0
  const source = { ownership: "owned" as const, createScope() { const scope = defaultPrivatePayloadStore.createScope(); scope.writer.registerPrivatePayload("ws_shared", payload); return { ...scope, dispose(): undefined { throw new Error("broken disposer") } } } }
  const result = requireEvents(await withResponsesServerToolShim([registration(ctx => { reader = ctx.store })], source)(invocation(), { requestStartedAt: 0 }, async () => llmEventResult({ [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true as const, value: undefined }), return: async () => { returned++; return { done: true as const, value: undefined } } }) }, identity)))
  expect(reader?.getPrivatePayload("ws_shared")).toBe(payload)
  const closing = result.discardProducer?.()
  expect(reader?.getPrivatePayload("ws_shared")).toBeUndefined()
  await expect(closing).rejects.toThrow("cleanup incomplete")
  expect(returned).toBe(1)
})

for (const exit of ["transform-error", "run-error", "non-events", "producer-acquisition-error"] as const) test(`active ${exit} disposes its scope before returning control`, async () => {
  let reader: ServerToolRequestCtx["store"] | undefined
  let disposed = 0
  let bodyDisposed = 0
  const source = { ownership: "owned" as const, createScope() { const scope = defaultPrivatePayloadStore.createScope(); scope.writer.registerPrivatePayload("ws_shared", payload); return { ...scope, dispose(): undefined { disposed++; return scope.dispose() } } } }
  const base = registration(ctx => { reader = ctx.store })
  const shim = withResponsesServerToolShim([async (inv, ctx) => { const prepared = await base(inv, ctx); return prepared.type === "active" && exit === "transform-error" ? { ...prepared, transformItems: () => { throw new Error("original transform") } } : prepared }], source)
  const running = shim(invocation(), { requestStartedAt: 0 }, async () => {
    if (exit === "run-error") throw new Error("original run")
    if (exit === "producer-acquisition-error") return { ...llmEventResult({ [Symbol.asyncIterator]: () => { throw new Error("original acquisition") } }, identity), discardProducer: async () => { bodyDisposed++ } }
    return { type: "upstream-error", status: 503, headers: new Headers(), body: new TextEncoder().encode("original unavailable") }
  })
  if (exit === "non-events") expect((await running).type).toBe("upstream-error")
  else await expect(running).rejects.toThrow("original")
  expect(disposed).toBe(1)
  expect(reader?.getPrivatePayload("ws_shared")).toBeUndefined()
  expect(bodyDisposed).toBe(exit === "producer-acquisition-error" ? 1 : 0)
})

test("metadata settlement uses the original identity rule once and resolves despite resolver failure", async () => {
  let resolutions = 0
  let returned = 0
  const base = frames()
  const source = { [Symbol.asyncIterator]: () => ({ next: () => base.next(), return: async () => { returned++; return base.return() } }) }
  const result = requireEvents(await withResponsesServerToolShim([registration()], defaultPrivatePayloadStore)(invocation(), { requestStartedAt: 0 }, async () => ({ ...llmEventResult(source, { ...identity, modelKey: "binding" }), resolveModelIdentity: () => { resolutions++; throw new Error("resolver unavailable") } })))
  await expect(drain(result)).rejects.toThrow("resolver unavailable")
  expect(await settles(result.finalMetadata ?? Promise.reject(new Error("Missing metadata")))).toMatchObject({ modelIdentity: { modelKey: "binding" } })
  await result.discardProducer?.()
  expect(resolutions).toBe(1)
  expect(returned).toBe(0)
})

test("unstarted closure never calls the identity resolver when the binding key is unchanged", async () => {
  let resolutions = 0
  const result = requireEvents(await withResponsesServerToolShim([registration()], defaultPrivatePayloadStore)(invocation(), { requestStartedAt: 0 }, async () => ({ ...llmEventResult(frames(), identity), resolveModelIdentity: () => { resolutions++; throw new Error("must not run") } })))
  await result.discardProducer?.()
  expect(await settles(result.finalMetadata ?? Promise.reject(new Error("Missing metadata")))).toMatchObject({ modelIdentity: identity })
  expect(resolutions).toBe(0)
})

for (const exit of ["invalid-request", "prepare-error", "historical-conflict"] as const) test(`early ${exit} cancels already adopted hosted work before returning control`, async () => {
  let cancels = 0
  let settlements = 0
  const work = { cancel: (): undefined => { cancels++; return undefined }, settled: async () => { settlements++ } }
  const base = registration()
  const first: ServerToolRegistration<Invocation, ServerToolRequestCtx> = async (inv, ctx) => {
    const prepared = await base(inv, ctx)
    if (prepared.type !== "active" || !prepared.hosted) throw new Error("Missing hosted")
    return { ...prepared, hosted: { ...prepared.hosted, work } }
  }
  const inv = invocation()
  if (exit === "historical-conflict") inv.payload.input = [{ type: "function_call", name: "web_search", call_id: "client", arguments: "{}" }]
  const later: ServerToolRegistration<Invocation, ServerToolRequestCtx> = () => {
    if (exit === "prepare-error") throw new Error("original preparation")
    return { type: "invalid-request", message: "original invalid", param: "tools" }
  }
  const pending = withResponsesServerToolShim([first, later], defaultPrivatePayloadStore)(inv, { requestStartedAt: 0 }, async () => { throw new Error("Must not run") })
  if (exit === "prepare-error") await expect(pending).rejects.toThrow("original preparation")
  else expect((await pending).type).toBe("upstream-error")
  expect(cancels).toBe(1)
  expect(settlements).toBe(1)
})

test("real eager search discard before slot acquisition aborts work and forbids late private writes or reentry", async () => {
  const { db, repo } = setupTestPlatform()
  const originalFetch = globalThis.fetch
  const started = Promise.withResolvers<AbortSignal>()
  const provider = Promise.withResolvers<Response>()
  const writes: unknown[] = []
  let calls = 0
  let slotRuns = 0
  try {
    await repo.apiKeys.save({ id: "eager-search-key" as ApiKeyId, name: "search", key: "sk-eager-search", createdAt: "2026-01-01T00:00:00Z", webSearchEnabled: true, modelMappingsEnabled: false, modelMappings: [], webSearchPriority: ["tavily"], webSearchTavilyKey: "fixture" })
    globalThis.fetch = (async (_url, init) => {
      if (!init?.signal) throw new Error("Missing provider signal")
      started.resolve(init.signal)
      return provider.promise
    }) as typeof fetch
    const actual: ServerToolRegistration<Invocation, ServerToolRequestCtx> = async (inv, ctx) => {
      const prepared = await webSearchServerTool(inv, ctx)
      if (prepared.type !== "active" || !prepared.hosted) throw new Error("Missing actual hosted tool")
      const hosted = prepared.hosted
      return { ...prepared, hosted: { ...hosted, dispatcher: args => hosted.dispatcher(args).map(slot => ({ ...slot, run: () => { slotRuns++; return slot.run() } })) } }
    }
    const result = requireEvents(await withResponsesServerToolShim([actual], { getPrivatePayload: () => undefined, registerPrivatePayload: (_id, value) => { writes.push(value) } })(invocation(), { requestStartedAt: 0, apiKeyId: "eager-search-key", downstreamAbortSignal: new AbortController().signal }, async () => { calls++; return llmEventResult(frames("query"), identity) }))
    const iterator = result.events[Symbol.asyncIterator]()
    for (;;) {
      const step = await iterator.next()
      if (step.done) throw new Error("Search not dispatched")
      if (step.value.type === "event" && step.value.event.type === "response.output_item.added" && step.value.event.item.type === "web_search_call") break
    }
    const signal = await started.promise
    expect(slotRuns).toBe(0)
    const closing = Promise.resolve(result.discardProducer?.()).then(() => "closed", error => error)
    expect(signal.aborted).toBe(true)
    provider.resolve(Response.json({ results: [{ url: "https://late.test", title: "late", content: "late" }] }))
    expect(await closing).toBe("closed")
    expect((await iterator.next()).done).toBe(true)
    expect(slotRuns).toBe(0)
    expect(calls).toBe(1)
    expect(writes).toEqual([])
  } finally { provider.resolve(Response.json({ results: [] })); globalThis.fetch = originalFetch; db.close() }
})

test("hosted work cancellation is synchronous and one throwing callback does not skip other work", async () => {
  const { ServerToolLifetime } = await import("../../../../../src/data-plane/chat-flow/responses/interceptors/server-tool-lifetime")
  const owner = new ServerToolLifetime(() => undefined)
  const cancelled: number[] = []
  const settlement = Promise.withResolvers<void>()
  owner.ownWork({ cancel: (): undefined => { cancelled.push(1); throw new Error("cancel failure") }, settled: () => settlement.promise })
  owner.ownWork({ cancel: (): undefined => { cancelled.push(2); return undefined }, settled: async () => {} })
  const closing = owner.close().catch(error => error)
  expect(cancelled).toEqual([1, 2])
  settlement.resolve()
  expect(await closing).toBeInstanceOf(Error)
})

test("incomplete hosted cleanup preserves an already decided invalid request", async () => {
  const base = registration()
  const first: ServerToolRegistration<Invocation, ServerToolRequestCtx> = async (inv, ctx) => {
    const prepared = await base(inv, ctx)
    if (prepared.type !== "active" || !prepared.hosted) throw new Error("Missing hosted")
    return { ...prepared, hosted: { ...prepared.hosted, work: { cancel: (): undefined => { throw new Error("broken cancellation") }, settled: async () => {} } } }
  }
  const result = await withResponsesServerToolShim([first, () => ({ type: "invalid-request", message: "original invalid", param: "tools" })], defaultPrivatePayloadStore)(invocation(), { requestStartedAt: 0 }, async () => { throw new Error("Must not run") })
  expect(result.type).toBe("upstream-error")
  if (result.type !== "upstream-error") throw new Error("Expected invalid result")
  expect(new TextDecoder().decode(result.body)).toContain("original invalid")
})

test("hosted cleanup deadline does not fake actual work settlement", async () => {
  const { ServerToolLifetime } = await import("../../../../../src/data-plane/chat-flow/responses/interceptors/server-tool-lifetime")
  const settlement = Promise.withResolvers<void>()
  let cancelled = false
  let settled = false
  const owner = new ServerToolLifetime(() => undefined)
  owner.ownWork({ cancel: (): undefined => { cancelled = true; return undefined }, settled: () => settlement.promise })
  const closing = owner.close()
  expect(cancelled).toBe(true)
  void settlement.promise.then(() => { settled = true })
  await expect(closing).rejects.toThrow("cleanup incomplete")
  expect(settled).toBe(false)
  settlement.resolve()
  await settlement.promise
  await expect(owner.close()).rejects.toThrow("cleanup incomplete")
})

test("actual hosted native JSON loop uses existing adapters and preserves private replay and final metadata", async () => {
  const { responsesResultToEvents } = await import("@vibe-llm/protocols/responses")
  const { respondResponses } = await import("../../../../../src/data-plane/chat-flow/responses/respond")
  const { db, repo } = setupTestPlatform()
  const originalFetch = globalThis.fetch
  let runs = 0
  const discarded: number[] = []
  try {
    await repo.apiKeys.save({ id: "json-search-key" as ApiKeyId, name: "search", key: "sk-json-search", createdAt: "2026-01-01T00:00:00Z", webSearchEnabled: true, modelMappingsEnabled: false, modelMappings: [], webSearchPriority: ["tavily"], webSearchTavilyKey: "fixture" })
    globalThis.fetch = (async () => Response.json({ results: [{ url: "https://json.test", title: "JSON search", content: "private JSON content" }] })) as unknown as typeof fetch
    const inv = invocation()
    inv.payload.stream = false
    const result = requireEvents(await withResponsesServerToolShim([webSearchServerTool], defaultPrivatePayloadStore)(inv, { requestStartedAt: 0, apiKeyId: "json-search-key" }, async () => {
      const turn = ++runs
      if (turn === 2) expect(JSON.stringify(inv.payload.input)).toContain("private JSON content")
      const body: ResponsesResult = { ...snapshot(), output: turn === 1 ? [{ type: "function_call", id: "fc_json", call_id: "json-call", name: "web_search", arguments: '{"search_query":[{"q":"json"}]}', status: "completed" }] : [{ type: "message", id: "msg_json", role: "assistant", status: "completed", content: [{ type: "output_text", text: "JSON answer", annotations: [] }] }] }
      return { ...llmEventResult((async function* () { yield* responsesResultToEvents(body, { genericOutputItems: true }) })(), identity), discardProducer: async () => { discarded.push(turn) } }
    }))
    const response = await respondResponses(result, { wantsStream: false })
    const body = await response.json() as ResponsesResult
    expect(body.status).toBe("completed")
    expect(body.output.filter(item => item.type === "web_search_call")).toHaveLength(1)
    expect(JSON.stringify(body)).toContain("JSON answer")
    expect(await result.finalMetadata).toMatchObject({ modelIdentity: identity })
    await result.discardProducer?.()
    expect(discarded).toEqual([])
    expect(runs).toBe(2)
  } finally { globalThis.fetch = originalFetch; db.close() }
})
