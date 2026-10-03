import { expect, test } from "bun:test"
import { UpstreamExchangeCollector, UPSTREAM_ATTEMPT_LIMITS } from "../src/shared/dump/upstream-attempts.ts"
import { boundedUtf8, createUpstreamDialObservationContext, operationForProviderRequest, type UpstreamOperation } from "../src/shared/dump/upstream-dial-adapter.ts"

test("operation comes from the declared provider endpoint and action", () => {
  expect([
    operationForProviderRequest({ endpoint: "chat_completions" }),
    operationForProviderRequest({ endpoint: "responses" }),
    operationForProviderRequest({ endpoint: "responses", action: "compact" }),
    operationForProviderRequest({ endpoint: "messages" }),
    operationForProviderRequest({ endpoint: "messages_count_tokens" }),
    operationForProviderRequest({ endpoint: "embeddings" }),
    operationForProviderRequest({ endpoint: "images_generations" }),
    operationForProviderRequest({ endpoint: "images_edits" }),
    operationForProviderRequest({ endpoint: "alpha_search" }),
  ]).toEqual([
    "chat.completions", "responses.create", "responses.compact", "messages.create", "count_tokens",
    "embeddings.create", "images.generate", "images.edit", "search",
  ])
})

const begin = (collector: UpstreamExchangeCollector, operation: UpstreamOperation = "responses.create") => {
  const context = createUpstreamDialObservationContext(collector)
  const call = context.forOperation({ upstreamId: "upstream_1", operation }).beginCall({
    upstreamId: "untrusted", url: "https://user:secret@example.test/secret?token=secret", startedAt: 1,
  })
  const attempt = call?.beginAttempt?.({
    transport: "direct_fetch", transportId: "direct_fetch", method: "POST",
    url: "https://user:secret@example.test/secret?token=secret", startedAt: 2,
    requestHeaders: new Headers({ Authorization: "Bearer secret", "Content-Type": "application/json; key=secret" }),
    body: { kind: "empty" },
  })
  if (!attempt) throw new Error("expected attempt")
  return { context, attempt }
}

test("one context gives endpoint observers unique parent IDs and fixed operations", () => {
  const collector = new UpstreamExchangeCollector()
  const context = createUpstreamDialObservationContext(collector)
  for (const operation of ["responses.create", "responses.compact", "images.edit"] as const) {
    const call = context.forOperation({ upstreamId: "upstream_1", operation }).beginCall({
      upstreamId: "untrusted", url: "https://secret.invalid/path", startedAt: 1,
    })
    call?.beginAttempt?.({
      transport: "direct_fetch", transportId: "direct_fetch", method: "POST", url: "https://secret.invalid/path",
      startedAt: 2, requestHeaders: undefined, body: { kind: "empty" },
    })?.onFetchError?.("network")
  }
  const attempts = collector.finish().attempts
  expect(attempts.map(item => item.parentCallId)).toEqual(["call_1", "call_2", "call_3"])
  expect(attempts.map(item => item.operation)).toEqual(["responses.create", "responses.compact", "images.edit"])
  expect(attempts.every(item => item.upstreamId === "upstream_1" && item.url === "url_omitted")).toBe(true)
})

test("bounded text encoding counts malformed UTF-16 and keeps exact mid-codepoint prefix", () => {
  const collector = new UpstreamExchangeCollector()
  const context = createUpstreamDialObservationContext(collector)
  const call = context.forOperation({ upstreamId: "upstream_1", operation: "responses.create" }).beginCall({
    upstreamId: "ignored", url: "https://example.test", startedAt: 1,
  })
  const text = "a".repeat(UPSTREAM_ATTEMPT_LIMITS.requestPrefix - 2) + "😀" + "\ud83d"
  call?.beginAttempt?.({
    transport: "direct_fetch", transportId: "direct_fetch", method: "POST", url: "https://example.test",
    startedAt: 2, requestHeaders: undefined, body: { kind: "text", text },
  })
  const request = collector.finish().attempts[0]?.request
  expect(request?.totalBytes).toBe(UPSTREAM_ATTEMPT_LIMITS.requestPrefix + 5)
  expect(request?.capturedBytes).toBe(UPSTREAM_ATTEMPT_LIMITS.requestPrefix)
  expect(request?.truncated).toBe(true)
  const prefix = Uint8Array.from(atob(request?.prefixBase64 ?? ""), char => char.charCodeAt(0))
  expect(Array.from(prefix.slice(-4))).toEqual([97, 97, 0xf0, 0x9f])
})

test("bounded UTF-8 preserves every byte boundary and counts the uncaptured suffix", () => {
  const text = "a\u0000é中😀\ud800b\udc00\ud800\ud800\udc00"
  const encoded = new TextEncoder().encode(text)
  for (let limit = 0; limit <= encoded.length + 2; limit++) {
    const result = boundedUtf8(text, limit)
    expect(result.totalBytes).toBe(encoded.length)
    expect(result.prefix).toEqual(encoded.subarray(0, limit))
    expect(result.prefix.buffer.byteLength).toBeLessThanOrEqual(limit)
  }
  expect(boundedUtf8("", 0)).toEqual({ prefix: new Uint8Array(0), totalBytes: 0 })
})

test("bounded UTF-8 reserves only captured bytes for short prepared bodies", () => {
  for (const text of ["plain ASCII", "é", "中", "😀", "a\ud800z"]) {
    const expected = new TextEncoder().encode(text)
    const result = boundedUtf8(text, UPSTREAM_ATTEMPT_LIMITS.requestPrefix)
    expect(result.prefix).toEqual(expected)
    expect(result.prefix.buffer.byteLength).toBe(expected.byteLength)
  }
})

test("bounded UTF-8 matches native encoding across malformed surrogate boundaries", () => {
  const units = [0, 0x7f, 0x80, 0x7ff, 0x800, 0xd7ff, 0xd800, 0xdbff, 0xdc00, 0xdfff, 0xe000, 0xffff]
  const encoder = new TextEncoder()
  for (const first of units) for (const second of units) for (const third of units) {
    const text = String.fromCharCode(first, second, third)
    const expected = encoder.encode(text)
    for (let limit = 0; limit <= expected.length + 1; limit++) {
      const result = boundedUtf8(text, limit)
      expect(result.totalBytes).toBe(expected.length)
      expect(result.prefix).toEqual(expected.subarray(0, limit))
      expect(result.prefix.buffer.byteLength).toBe(result.prefix.byteLength)
    }
  }
})

test("prepared byte prefix is copied before dispatch and opaque bodies stay unobserved", () => {
  const collector = new UpstreamExchangeCollector()
  const context = createUpstreamDialObservationContext(collector)
  const dial = context.forOperation({ upstreamId: "upstream_1", operation: "responses.create" })
  const bytes = new Uint8Array(1024 * 1024).fill(65)
  for (const body of [{ kind: "bytes" as const, bytes }, { kind: "unobserved" as const }]) {
    dial.beginCall({ upstreamId: "ignored", url: "https://example.test", startedAt: 1 })?.beginAttempt?.({
      transport: "direct_fetch", transportId: "direct_fetch", method: "POST", url: "https://example.test",
      startedAt: 2, requestHeaders: undefined, body,
    })
  }
  bytes.fill(66)
  const attempts = collector.finish().attempts
  expect(attempts[0]?.request.totalBytes).toBe(bytes.length)
  expect(attempts[0]?.request.capturedBytes).toBe(UPSTREAM_ATTEMPT_LIMITS.requestPrefix)
  expect(atob(attempts[0]?.request.prefixBase64 ?? "").slice(0, 1)).toBe("A")
  expect(attempts[1]?.request.source).toBe("unobserved")
  expect(attempts[1]?.request.totalBytes).toBeNull()
})

test("response wrapper preserves metadata and clones only on explicit clone", async () => {
  const collector = new UpstreamExchangeCollector()
  const { attempt } = begin(collector)
  let pulls = 0
  const source = new Response(new ReadableStream<Uint8Array>({
    pull(controller) { pulls++; controller.enqueue(Uint8Array.of(1, 2)); controller.close() },
  }, { highWaterMark: 0 }), { status: 202, statusText: "Accepted", headers: { "Content-Type": "application/json" } })
  Object.defineProperties(source, {
    url: { value: "https://example.test/final", configurable: true },
    redirected: { value: true, configurable: true },
    type: { value: "cors", configurable: true },
  })
  const observed = attempt.onResponse?.(source)
  expect(observed).toBeInstanceOf(Response)
  expect(pulls).toBe(0)
  expect(source.bodyUsed).toBe(false)
  expect(source.body?.locked).toBe(false)
  expect(observed?.status).toBe(202)
  expect(observed?.statusText).toBe("Accepted")
  expect(observed?.headers.get("content-type")).toBe("application/json")
  expect(observed?.url).toBe("https://example.test/final")
  expect(observed?.redirected).toBe(true)
  expect(observed?.type).toBe("cors")
  const clone = observed?.clone()
  expect(clone?.url).toBe(observed?.url)
  expect(clone?.redirected).toBe(true)
  expect(clone?.type).toBe("cors")
  expect(await observed?.arrayBuffer()).toEqual(Uint8Array.of(1, 2).buffer)
  expect(await clone?.arrayBuffer()).toEqual(Uint8Array.of(1, 2).buffer)
  expect(collector.finish().attempts[0]?.response.terminal).toBe("eof")
})

test("pending read cancellation reaches source and cannot become EOF", async () => {
  const collector = new UpstreamExchangeCollector()
  const { attempt } = begin(collector)
  let cancelled: unknown
  const source = new Response(new ReadableStream<Uint8Array>({
    pull() { return new Promise<void>(() => {}) },
    cancel(reason) { cancelled = reason },
  }, { highWaterMark: 0 }))
  const observed = attempt.onResponse?.(source)
  const reader = observed?.body?.getReader()
  const pending = reader?.read()
  await Promise.resolve()
  await reader?.cancel("stop")
  await pending
  expect(cancelled).toBe("stop")
  const response = collector.finish().attempts[0]?.response
  expect(response?.terminal).toBe("cancelled")
  expect(response?.totalBytes).toBeNull()
})

test("status zero is left untouched", () => {
  const collector = new UpstreamExchangeCollector()
  const { attempt } = begin(collector)
  const opaque = Response.error()
  expect(attempt.onResponse?.(opaque)).toBe(opaque)
  const snapshot = collector.finish().attempts[0]
  expect(snapshot?.status).toBeNull()
  expect(snapshot?.response.terminal).toBe("not_consumed")
})

test("metadata wrapping failure returns the original readable response", async () => {
  const collector = new UpstreamExchangeCollector()
  const { attempt } = begin(collector)
  const source = new Response("still readable")
  Object.defineProperty(source, "url", { get() { throw new Error("metadata failure") } })
  expect(attempt.onResponse?.(source)).toBe(source)
  expect(await source.text()).toBe("still readable")
})

test("source read failure remains a read error", async () => {
  const collector = new UpstreamExchangeCollector()
  const { attempt } = begin(collector)
  const source = new Response(new ReadableStream<Uint8Array>({
    pull(controller) { controller.error(new Error("source failed")) },
  }, { highWaterMark: 0 }))
  const observed = attempt.onResponse?.(source)
  await expect(observed?.text()).rejects.toThrow("source failed")
  const terminal = collector.finish().attempts[0]
  expect(terminal?.response.terminal).toBe("read_error")
  expect(terminal?.errorCategory).toBe("read")
})

test("collector consumes a lazy header iterable within metadata limits", () => {
  const collector = new UpstreamExchangeCollector()
  let enumerated = 0
  const headers = {
    *[Symbol.iterator](): Generator<readonly [string, string]> {
      for (let i = 0; i < 10_000; i++) {
        enumerated++
        yield ["Authorization", "Bearer secret"]
      }
    },
  }
  const attempt = collector.begin({
    parentCallId: "call_1", upstreamId: "upstream_1", method: "POST",
    operation: "responses.create", requestHeaders: headers,
  })
  expect(attempt).not.toBeNull()
  expect(enumerated).toBe(10_000)
  const item = collector.finish().attempts[0]
  expect(item?.requestHeaders).toEqual([])
  expect(item?.omittedRequestHeaders).toBe(10_000)
})

test("adapter observes native header fields despite subclass traversal overrides", async () => {
  class NativeHeaders extends Headers {}
  const requestHeaders = new NativeHeaders({ "Content-Type": "application/json", Authorization: "private" })
  const responseHeaders = new NativeHeaders({ "Content-Type": "text/event-stream", "Set-Cookie": "private" })
  for (const headers of [requestHeaders, responseHeaders]) {
    Object.defineProperties(headers, {
      entries: { value: function* () { yield ["content-type", "text/plain"] } },
      forEach: { value: () => { throw new Error("spoofed visitation") } },
    })
  }
  const collector = new UpstreamExchangeCollector()
  const call = createUpstreamDialObservationContext(collector).forOperation({ upstreamId: "upstream_1", operation: "responses.create" })
    .beginCall({ upstreamId: "ignored", url: "https://example.test", startedAt: 1 })
  const attempt = call?.beginAttempt?.({
    transport: "direct_fetch", transportId: "direct_fetch", method: "POST", url: "https://example.test",
    requestHeaders, body: { kind: "empty" }, startedAt: 2,
  })
  if (!attempt) throw new Error("attempt expected")
  const source = new Response("original bytes", { status: 202 })
  Object.defineProperty(source, "headers", { value: responseHeaders })
  const observed = attempt.onResponse?.(source)
  expect(observed?.status).toBe(202)
  expect(await observed?.text()).toBe("original bytes")
  expect(collector.finish().attempts[0]).toMatchObject({
    requestHeaders: [["content-type", "application/json"]], omittedRequestHeaders: 1,
    responseHeaders: [["content-type", "text/event-stream"]], omittedResponseHeaders: 1,
    response: { terminal: "eof", observedBytes: 14, totalBytes: 14 },
  })
})

test("diagnostic record iteration failure remains best effort", () => {
  const collector = new UpstreamExchangeCollector()
  const call = createUpstreamDialObservationContext(collector).forOperation({ upstreamId: "upstream_1", operation: "responses.create" })
    .beginCall({ upstreamId: "ignored", url: "https://example.test", startedAt: 1 })
  const requestHeaders = new Proxy({ "content-type": "application/json" }, { ownKeys() { throw new Error("diagnostic iterator failure") } })
  const attempt = call?.beginAttempt?.({
    transport: "proxy", transportId: "proxy_1", method: "POST", url: "https://example.test",
    requestHeaders, body: { kind: "empty" }, startedAt: 2,
  })
  expect(attempt).toBeUndefined()
  expect(collector.finish().attempts[0]?.response.terminal).toBe("not_consumed")
})

test("finishing before cancellation preserves incomplete snapshot without blocking later source cancel", async () => {
  const collector = new UpstreamExchangeCollector()
  const { attempt } = begin(collector)
  let reason: unknown
  const source = new Response(new ReadableStream<Uint8Array>({ cancel(value) { reason = value } }, { highWaterMark: 0 }))
  const observed = attempt.onResponse?.(source)
  expect(collector.finish().attempts[0]?.response.terminal).toBe("not_consumed")
  await observed?.body?.cancel("late")
  expect(reason).toBe("late")
  expect(collector.finish().attempts[0]?.response.terminal).toBe("not_consumed")
})
