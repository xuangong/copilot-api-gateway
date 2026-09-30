import { expect, spyOn, test } from "bun:test"
import { UpstreamExchangeCollector, safeUpstreamExchangesForPersistence } from "../src/shared/dump/upstream-attempts.ts"
import type { CapturedAttemptBody } from "../src/shared/dump/upstream-attempts.ts"
import type { UpstreamExchanges } from "../src/shared/dump/upstream-attempts.ts"

const begin = (collector: UpstreamExchangeCollector) => collector.begin({
  parentCallId: "call-1", upstreamId: "upstream-1", method: "POST", operation: "responses.create",
})!

function capturedRequest() {
  const collector = new UpstreamExchangeCollector()
  begin(collector).observePreparedRequest({ prefix: Uint8Array.of(1, 2, 3, 4), totalBytes: 4 })
  return collector.finish()
}

function countAlphabetScans<T>(run: () => T) {
  const pattern = /[^A-Za-z0-9+/]/.source
  const testRegex = RegExp.prototype.test
  let calls = 0, units = 0
  const observer = spyOn(RegExp.prototype, "test").mockImplementation(function (this: RegExp, value) {
    if (this.source === pattern) { calls++; units += value.length }
    return testRegex.call(this, value)
  })
  try { return { value: run(), counts: () => ({ calls, units }) } }
  finally { observer.mockRestore() }
}

test("internally encoded frozen request and response bodies avoid repeated alphabet scans", async () => {
  const collector = new UpstreamExchangeCollector()
  const attempt = begin(collector)
  const request = new Uint8Array(65536).fill(255)
  attempt.observePreparedRequest({ prefix: request, totalBytes: request.byteLength })
  request.fill(0)
  const response = new Uint8Array(5001).fill(17)
  await new Response(attempt.observeResponse(200, [], new ReadableStream({
    start(controller) { controller.enqueue(response); controller.close() },
  }))).arrayBuffer()
  response.fill(0)
  const snapshot = collector.finish()
  const { value, counts } = countAlphabetScans(() => safeUpstreamExchangesForPersistence(snapshot))
  expect(value).toEqual(snapshot)
  expect(counts()).toEqual({ calls: 0, units: 0 })
  for (const body of [snapshot.attempts[0]!.request, snapshot.attempts[0]!.response]) {
    expect(Object.isFrozen(body)).toBe(true)
    expect(Object.getOwnPropertyDescriptor(body, "prefixBase64")).toMatchObject({ writable: false, configurable: false })
    expect(() => Object.assign(body, { prefixBase64: "invalid" })).toThrow()
  }
  expect(atob(snapshot.attempts[0]!.request.prefixBase64).charCodeAt(0)).toBe(255)
  expect(atob(snapshot.attempts[0]!.response.prefixBase64).charCodeAt(0)).toBe(17)
  expect(collector.finish()).toBe(snapshot)
})

const lookalikes: Array<[string, (body: CapturedAttemptBody) => CapturedAttemptBody]> = [
  ["spread", body => ({ ...body })],
  ["plain frozen", body => Object.freeze({ ...body })],
  ["structured clone", body => structuredClone(body)],
  ["JSON round-trip", body => JSON.parse(JSON.stringify(body)) as CapturedAttemptBody],
  ["Proxy", body => new Proxy(body, {})],
  ["Object.create", body => Object.create(body) as CapturedAttemptBody],
  ["descriptor copy", body => Object.create(Object.getPrototypeOf(body), Object.getOwnPropertyDescriptors(body)) as CapturedAttemptBody],
]

test.each(lookalikes)("%s body identity never inherits internal prefix provenance", (_name, wrap) => {
  const snapshot = capturedRequest()
  const item = snapshot.attempts[0]!
  const replace = (request: CapturedAttemptBody) => ({ ...snapshot, attempts: [{ ...item, request }] })
  const lookalike = wrap(item.request)
  expect(lookalike).not.toBe(item.request)
  const { value, counts } = countAlphabetScans(() => safeUpstreamExchangesForPersistence(replace(lookalike)))
  expect(value).toEqual(snapshot)
  expect(counts()).toEqual({ calls: 1, units: 6 })
  const malformed = wrap({ ...item.request, prefixBase64: `!${item.request.prefixBase64.slice(1)}` })
  expect(() => safeUpstreamExchangesForPersistence(replace(malformed))).toThrow("invalid upstream body prefix")
})

test("complete internal envelopes reuse the frozen projection by exact identity", () => {
  const snapshot = capturedRequest()
  const projected = safeUpstreamExchangesForPersistence(snapshot)
  expect(projected).toBe(snapshot)
  expect(projected.attempts).toBe(snapshot.attempts)
  expect(projected.attempts[0]?.request).toBe(snapshot.attempts[0]?.request)
  expect(projected.attempts[0]?.requestHeaders).toBe(snapshot.attempts[0]?.requestHeaders)
  expect(collectorLookalike(snapshot)).not.toBe(snapshot)
})

function collectorLookalike(snapshot: ReturnType<UpstreamExchangeCollector["finish"]>) {
  return safeUpstreamExchangesForPersistence({ ...snapshot })
}

test("external safe projection output remains unregistered and receives full validation", () => {
  const snapshot = capturedRequest()
  const projected = collectorLookalike(snapshot)
  expect(projected.attempts[0]!.request).not.toBe(snapshot.attempts[0]!.request)
  const { value, counts } = countAlphabetScans(() => safeUpstreamExchangesForPersistence(projected))
  expect(value).toEqual(snapshot)
  expect(counts()).toEqual({ calls: 2, units: 6 })
})

const envelopeLookalikes: Array<[string, (value: UpstreamExchanges) => unknown]> = [
  ["spread", value => ({ ...value })],
  ["plain frozen", value => Object.freeze({ ...value })],
  ["structured clone", value => structuredClone(value)],
  ["JSON round-trip", value => JSON.parse(JSON.stringify(value)) as unknown],
  ["Proxy", value => new Proxy(value, {})],
  ["Object.create", value => Object.create(value) as unknown],
  ["descriptor copy", value => Object.create(Object.getPrototypeOf(value), Object.getOwnPropertyDescriptors(value)) as unknown],
]

test.each(envelopeLookalikes)("%s envelope does not inherit complete safety provenance", (_name, wrap) => {
  const snapshot = capturedRequest()
  const input = wrap(snapshot)
  const projected = safeUpstreamExchangesForPersistence(input)
  expect(projected).not.toBe(input)
  expect(projected).not.toBe(snapshot)
  expect(projected).toEqual(snapshot)
  expect(() => safeUpstreamExchangesForPersistence(wrap({ ...snapshot, capturedBodyBytes: 5 }))).toThrow("upstream exchange budget mismatch")
})

test("reusing a known body in an external envelope preserves every other validation boundary", () => {
  const snapshot = capturedRequest()
  const item = snapshot.attempts[0]!
  const cases = [
    { ...snapshot, capturedBodyBytes: snapshot.capturedBodyBytes + 1 },
    { ...snapshot, metadataBytes: snapshot.metadataBytes + 1 },
    { ...snapshot, attempts: [{ ...item, order: 2 }] },
    { ...snapshot, attempts: [{ ...item, url: "https://secret.invalid/" }] },
    { ...snapshot, attempts: [{ ...item, requestHeaders: [["authorization", "secret"]] }] },
    { ...snapshot, attempts: [{ ...item, response: item.request }] },
    { ...snapshot, attempts: [{ ...item, request: item.response }] },
  ]
  for (const value of cases) expect(() => safeUpstreamExchangesForPersistence(value)).toThrow()
  const projected = safeUpstreamExchangesForPersistence({ ...snapshot, secret: "must-not-persist", attempts: [{ ...item, secret: "must-not-persist" }] })
  expect(projected).toEqual(snapshot)
  expect(JSON.stringify(projected)).not.toContain("must-not-persist")
})

test("internally generated repeated-response count inconsistencies still fail persistence", async () => {
  const collector = new UpstreamExchangeCollector()
  const attempt = begin(collector)
  attempt.observeResponse(204, [], null)
  await new Response(attempt.observeResponse(200, [], new ReadableStream({
    start(controller) { controller.enqueue(Uint8Array.of(1)); controller.close() },
  }))).arrayBuffer()
  const snapshot = collector.finish()
  expect(snapshot.attempts[0]!.response).toMatchObject({ terminal: "eof", totalBytes: 0, observedBytes: 1, prefixBase64: "AQ==" })
  expect(() => safeUpstreamExchangesForPersistence(snapshot)).toThrow("invalid upstream response count")

  const failed = new UpstreamExchangeCollector()
  const failedAttempt = begin(failed)
  failedAttempt.fetchError("network")
  failedAttempt.observeResponse(204, [], null)
  expect(() => safeUpstreamExchangesForPersistence(failed.finish())).toThrow("invalid upstream response count")
})

test("a body from a failed finish is unregistered while a successful retry is registered", () => {
  const collector = new UpstreamExchangeCollector()
  begin(collector).observePreparedRequest({ prefix: Uint8Array.of(1, 2, 3, 4), totalBytes: 4 })
  const freeze = Object.freeze
  let unpublished: CapturedAttemptBody | undefined
  const fault = spyOn(Object, "freeze").mockImplementation(value => {
    if (value && typeof value === "object" && "source" in value) {
      if (value.source === "fetch-body") throw new Error("snapshot freeze failed")
      if (value.source === "prepared") unpublished = value as CapturedAttemptBody
    }
    return freeze(value)
  })
  try { expect(() => collector.finish()).toThrow("snapshot freeze failed") }
  finally { fault.mockRestore() }
  expect(unpublished).toBeDefined()
  expect(Object.isFrozen(unpublished)).toBe(true)
  const snapshot = collector.finish()
  expect(snapshot.attempts[0]!.request).not.toBe(unpublished)
  const external = { ...snapshot, attempts: [{ ...snapshot.attempts[0]!, request: unpublished! }] }
  const retry = countAlphabetScans(() => safeUpstreamExchangesForPersistence(snapshot))
  expect(retry.value).toEqual(snapshot)
  expect(retry.counts()).toEqual({ calls: 0, units: 0 })
  const prior = countAlphabetScans(() => safeUpstreamExchangesForPersistence(external))
  expect(prior.value).toEqual(snapshot)
  expect(prior.counts()).toEqual({ calls: 1, units: 6 })
})
