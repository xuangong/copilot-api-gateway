// packages/gateway/tests/protection-observe.test.ts
import { expect, test } from "bun:test"
import { HTTPError, type ProviderRequest, type ProviderResponse } from "@vibe-llm/provider-llm"
import { recordResponse, recordThrown, retriedAttemptObserver, withUpstreamProtection } from "../src/protection/observe"
import type { UpstreamOutcome } from "../src/protection/runtime"

const identity = { upstreamId: "up_test_o", keyId: "key_test_1", model: "gpt-x" }
const request = { signal: undefined } as unknown as ProviderRequest
const recorder = () => {
  const seen: Array<UpstreamOutcome | Promise<UpstreamOutcome>> = []
  return { runtime: () => ({ record: (o: UpstreamOutcome | Promise<UpstreamOutcome>) => { seen.push(o) } }), outcomes: () => Promise.all(seen) }
}
const provider = (status: number, body: string | null, headers: Record<string, string> = { "content-type": "application/json" }): ProviderResponse =>
  ({ status, headers: new Headers(headers), body: body === null ? null : new Response(body).body })

test("a 2xx response is returned untouched and recorded as ok", async () => {
  const r = recorder()
  const response = provider(200, "{}")
  const result = await withUpstreamProtection(identity, async () => response, r.runtime)(request)
  expect(result).toBe(response)
  expect(await r.outcomes()).toEqual([{ ...identity, cls: "ok", status: 200, code: "", message: "" }])
})

test("a 429 is classified, its error described, and the client still receives the whole body", async () => {
  const r = recorder()
  const body = JSON.stringify({ error: { message: "Too many requests", code: "rate_limit_exceeded" } })
  const result = await withUpstreamProtection(identity, async () => provider(429, body), r.runtime)(request)
  expect(result.status).toBe(429)
  expect(await new Response(result.body).text()).toBe(body)
  expect(await r.outcomes()).toEqual([{ ...identity, cls: "rate_limited", status: 429, code: "rate_limit_exceeded", message: "Too many requests" }])
})

test("an HTML 502 is an upstream error with no message; an unclassified status is `other` and not read", async () => {
  const r = recorder()
  await withUpstreamProtection(identity, async () => provider(502, "<html>bad gateway</html>", { "content-type": "text/html" }), r.runtime)(request)
  const other = provider(418, "teapot")
  const result = await withUpstreamProtection(identity, async () => other, r.runtime)(request)
  expect(result).toBe(other)
  expect(await r.outcomes()).toEqual([
    { ...identity, cls: "upstream", status: 502, code: "", message: "" },
    { ...identity, cls: "other", status: 418, code: "", message: "" }])
})

test("a stream that starts with 2xx and fails mid-way counts as ok: the account was not refused", async () => {
  const r = recorder()
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode("data: x\n\n")); controller.error(new TypeError("terminated")) } })
  const response = { status: 200, headers: new Headers({ "content-type": "text/event-stream" }), body } as ProviderResponse
  const result = await withUpstreamProtection(identity, async () => response, r.runtime)(request)
  await expect(new Response(result.body).text()).rejects.toBeInstanceOf(TypeError)
  expect(await r.outcomes()).toEqual([{ ...identity, cls: "ok", status: 200, code: "", message: "" }])
})

test("a thrown HTTPError is recorded by its status and rethrown unchanged", async () => {
  const r = recorder()
  const error = new HTTPError("bad", new Response(JSON.stringify({ error: { message: "content filtered" } }), { status: 400 }))
  await expect(withUpstreamProtection(identity, async () => { throw error }, r.runtime)(request)).rejects.toBe(error)
  expect(await error.response.text()).toContain("content filtered") // the caller can still read it
  expect(await r.outcomes()).toEqual([{ ...identity, cls: "rejected", status: 400, code: "", message: "content filtered" }])
})

test("transport failures are network with the error name; aborts and gateway errors are not recorded", async () => {
  const r = recorder()
  const net = new TypeError("fetch failed")
  await expect(withUpstreamProtection(identity, async () => { throw net }, r.runtime)(request)).rejects.toBe(net)
  const aborted = new AbortController(); aborted.abort()
  await expect(withUpstreamProtection(identity, async () => { throw new TypeError("x") }, r.runtime)({ signal: aborted.signal } as ProviderRequest)).rejects.toBeInstanceOf(TypeError)
  await expect(withUpstreamProtection(identity, async () => { throw new Error("affinity routing unavailable") }, r.runtime)(request)).rejects.toThrow("affinity")
  expect(await r.outcomes()).toEqual([{ ...identity, cls: "network", status: 0, code: "", message: "TypeError" }])
})

test("a failing recorder never changes what the caller sees", async () => {
  const boom = () => ({ record: () => { throw new Error("boom") } })
  const ok = provider(200, "{}")
  expect(await withUpstreamProtection(identity, async () => ok, boom)(request)).toBe(ok)
  const limited = await withUpstreamProtection(identity, async () => provider(429, "{}"), boom)(request)
  expect(await new Response(limited.body).text()).toBe("{}")
  await expect(withUpstreamProtection(identity, async () => { throw new TypeError("x") }, boom)(request)).rejects.toBeInstanceOf(TypeError)
})

test("recordResponse works on a Response (embeddings, images) without consuming it", async () => {
  const r = recorder()
  const response = new Response(JSON.stringify({ error: { message: "bad key", type: "invalid_request_error" } }), { status: 401 })
  recordResponse(identity, response, r.runtime)
  expect(await response.json()).toEqual({ error: { message: "bad key", type: "invalid_request_error" } })
  expect(await r.outcomes()).toEqual([{ ...identity, cls: "auth", status: 401, code: "invalid_request_error", message: "bad key" }])
  recordThrown(identity, new Error("plain"), undefined, r.runtime)
  expect(await r.outcomes()).toHaveLength(1)
})

test("retried attempts the provider reports are recorded by class only; the final response is recorded by the wrapper: 429,429,200 is 2 rate_limited + 1 ok", async () => {
  const r = recorder()
  const wrapped = withUpstreamProtection(identity, async (req) => {
    req.onRetriedAttempt?.({ status: 429 })
    req.onRetriedAttempt?.({ status: 429 })
    return provider(200, "{}")
  }, r.runtime)
  const result = await wrapped(request)
  expect(result.status).toBe(200)
  expect(await r.outcomes()).toEqual([
    { ...identity, cls: "rate_limited", status: 429, code: "", message: "" },
    { ...identity, cls: "rate_limited", status: 429, code: "", message: "" },
    { ...identity, cls: "ok", status: 200, code: "", message: "" }])
})

test("a retried transport failure is network; an aborted caller is ignored; a failing recorder never reaches the provider", async () => {
  const r = recorder()
  await withUpstreamProtection(identity, async (req) => {
    req.onRetriedAttempt?.({ error: Object.assign(new Error("Request timeout after 5ms"), { name: "TimeoutError" }) })
    req.onRetriedAttempt?.({ error: new Error("plain") })
    return provider(200, "{}")
  }, r.runtime)(request)
  expect((await r.outcomes()).map(o => [o.cls, o.status, o.message])).toEqual([["network", 0, "TimeoutError"], ["ok", 200, ""]])

  const aborted = new AbortController(); aborted.abort()
  const r2 = recorder()
  await withUpstreamProtection(identity, async (req) => { req.onRetriedAttempt?.({ status: 502 }); return provider(200, "{}") }, r2.runtime)({ signal: aborted.signal } as ProviderRequest)
  expect((await r2.outcomes()).map(o => o.cls)).toEqual(["upstream", "ok"]) // a retried response did reach the upstream, abort or not

  const boom = () => ({ record: () => { throw new Error("boom") } })
  const ok = provider(200, "{}")
  const result = await withUpstreamProtection(identity, async (req) => { req.onRetriedAttempt?.({ status: 429 }); return ok }, boom)(request)
  expect(result).toBe(ok)
})

test("TimeoutError, transport-marked HTTPError and Workers-style connection errors are network", async () => {
  const r = recorder()
  const timeout = Object.assign(new Error("Request timeout after 5ms (1 attempts)"), { name: "TimeoutError" })
  await expect(withUpstreamProtection(identity, async () => { throw timeout }, r.runtime)(request)).rejects.toBe(timeout)
  const transport = new HTTPError("Failed to call x: connection refused", new Response("connection refused", { status: 502 }), { transport: true, cause: new TypeError("connection refused") })
  await expect(withUpstreamProtection(identity, async () => { throw transport }, r.runtime)(request)).rejects.toBe(transport)
  const lost = new Error("Network connection lost.")
  await expect(withUpstreamProtection(identity, async () => { throw lost }, r.runtime)(request)).rejects.toBe(lost)
  const upstream502 = new HTTPError("bad", new Response("{}", { status: 502 }))
  await expect(withUpstreamProtection(identity, async () => { throw upstream502 }, r.runtime)(request)).rejects.toBe(upstream502)
  expect((await r.outcomes()).map(o => [o.cls, o.status, o.message])).toEqual([
    ["network", 0, "TimeoutError"], ["network", 0, "TypeError"], ["network", 0, "Error"], ["upstream", 502, ""]])
})

test("a caller abort wins over an HTTPError", async () => {
  const r = recorder()
  const aborted = new AbortController(); aborted.abort()
  const error = new HTTPError("x", new Response("{}", { status: 429 }))
  await expect(withUpstreamProtection(identity, async () => { throw error }, r.runtime)({ signal: aborted.signal } as ProviderRequest)).rejects.toBe(error)
  expect(await r.outcomes()).toEqual([])
})

test("a large, slowly delivered 429 body reaches the client byte for byte while the observer reads only its prefix", async () => {
  const r = recorder()
  const chunk = "x".repeat(1024)
  const total = 20
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(new TextEncoder().encode(JSON.stringify({ error: { message: "slow" } }).slice(0, -1) + ',"pad":"'))
      for (let i = 0; i < total; i++) { await new Promise(resolve => setTimeout(resolve, 2)); controller.enqueue(new TextEncoder().encode(chunk)) }
      controller.enqueue(new TextEncoder().encode('"}}'))
      controller.close()
    },
  })
  const result = await withUpstreamProtection(identity, async () => ({ status: 429, headers: new Headers(), body }) as ProviderResponse, r.runtime)(request)
  const text = await new Response(result.body).text()
  expect(text.length).toBe(JSON.stringify({ error: { message: "slow" } }).length - 1 + ',"pad":"'.length + total * 1024 + 3)
  expect(text.endsWith('"}}')).toBe(true)
  expect((await r.outcomes())[0]).toMatchObject({ cls: "rate_limited", message: "slow" })
})

test("retriedAttemptObserver records a retried status or transport error for non-chat calls", async () => {
  const r = recorder()
  const observe = retriedAttemptObserver(identity, undefined, r.runtime)
  observe({ status: 503 })
  observe({ error: new TypeError("fetch failed") })
  expect((await r.outcomes()).map(o => [o.cls, o.status])).toEqual([["upstream", 503], ["network", 0]])
})

test("a gateway-generated response (never sent upstream) is returned untouched and not recorded", async () => {
  const r = recorder()
  const synthetic = { ...provider(429, '{"error":{"type":"codex_rate_limited"}}'), gatewayGenerated: true } as ProviderResponse
  const result = await withUpstreamProtection(identity, async () => synthetic, r.runtime)(request)
  expect(result).toBe(synthetic)
  expect(await new Response(result.body).text()).toContain("codex_rate_limited")
  expect(await r.outcomes()).toEqual([])
})

test("an auth rejection the provider refreshed and replayed is `other` (not risky); a replaced one and a final one stay auth", async () => {
  const r = recorder()
  const wrapped = withUpstreamProtection(identity, async (req) => {
    req.onRetriedAttempt?.({ status: 403, outcome: "replayed" })
    req.onRetriedAttempt?.({ status: 401, outcome: "replaced" })
    req.onRetriedAttempt?.({ status: 401 })
    req.onRetriedAttempt?.({ status: 429, outcome: "replayed" })
    return provider(401, "{}")
  }, r.runtime)
  await wrapped(request)
  expect((await r.outcomes()).map(o => [o.cls, o.status])).toEqual([["other", 403], ["auth", 401], ["auth", 401], ["rate_limited", 429], ["auth", 401]])
})
