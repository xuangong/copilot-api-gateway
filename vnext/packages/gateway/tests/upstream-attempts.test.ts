import { expect, test } from "bun:test"
import { UpstreamExchangeCollector, UPSTREAM_ATTEMPT_LIMITS, safeUpstreamExchangesForPersistence } from "../src/shared/dump/upstream-attempts.ts"

const bytes = (length: number): Uint8Array => new Uint8Array(length).fill(65)
const begin = (collector: UpstreamExchangeCollector) => collector.begin({
  parentCallId: "call-1", upstreamId: "upstream-1", method: "POST",
  operation: "responses.create", url: "https://user:password@host.invalid/secret/path?token=secret#secret",
  requestHeaders: [["Authorization", "Bearer secret"], ["X-Account-Credential", "secret"], ["Content-Type", "application/json; token=secret"]],
})

test("prepared and response prefixes preserve binary bytes and sanitize metadata before snapshot", async () => {
  const collector = new UpstreamExchangeCollector(1000)
  const attempt = begin(collector)
  if (!attempt) throw new Error("attempt omitted")
  attempt.observePreparedRequest({ prefix: Uint8Array.of(0xff, 0xfe, 0), totalBytes: 3 })
  const source = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(Uint8Array.of(0xff, 0xfe, 0)); controller.close() } })
  const body = attempt.observeResponse(200, [["Set-Cookie", "secret"], ["Content-Type", "text/event-stream; token=secret"]], source)
  expect(Array.from(new Uint8Array(await new Response(body).arrayBuffer()))).toEqual([255, 254, 0])
  const snapshot = collector.finish(1010)
  const item = snapshot.attempts[0]
  expect(item?.request.prefixBase64).toBe("//4A")
  expect(item?.response.prefixBase64).toBe("//4A")
  expect(item?.response.totalBytes).toBe(3)
  expect(item?.response.terminal).toBe("eof")
  expect(item?.operation).toBe("responses.create")
  expect(item?.url).toBe("url_omitted")
  expect(JSON.stringify(snapshot)).not.toContain("secret")
  expect(item?.requestHeaders).toEqual([["content-type", "application/json"]])
  expect(item?.responseHeaders).toEqual([["content-type", "text/event-stream"]])
  expect(Object.isFrozen(snapshot.attempts[0])).toBe(true)
})

test("per-attempt and total byte caps count forwarded bytes beyond captured prefixes", async () => {
  const collector = new UpstreamExchangeCollector()
  for (let n = 0; n < UPSTREAM_ATTEMPT_LIMITS.attempts; n++) {
    const attempt = begin(collector)
    if (!attempt) throw new Error("attempt omitted")
    attempt.observePreparedRequest({ prefix: bytes(UPSTREAM_ATTEMPT_LIMITS.requestPrefix + 1), totalBytes: UPSTREAM_ATTEMPT_LIMITS.requestPrefix + 1 })
    const chunk = bytes(UPSTREAM_ATTEMPT_LIMITS.responsePrefix + 1)
    const body = attempt.observeResponse(200, [], new ReadableStream({ start(controller) { controller.enqueue(chunk); controller.close() } }))
    expect((await new Response(body).arrayBuffer()).byteLength).toBe(chunk.byteLength)
  }
  expect(begin(collector)).toBeNull()
  const snapshot = collector.finish()
  expect(snapshot.omittedAttempts).toBe(1)
  expect(snapshot.capturedBodyBytes).toBe(UPSTREAM_ATTEMPT_LIMITS.totalBodyBytes)
  expect(snapshot.attempts[0]?.request.capturedBytes).toBe(UPSTREAM_ATTEMPT_LIMITS.requestPrefix)
  expect(snapshot.attempts[0]?.request.truncated).toBe(true)
  expect(snapshot.attempts[0]?.response.capturedBytes).toBe(UPSTREAM_ATTEMPT_LIMITS.responsePrefix)
  expect(snapshot.attempts[0]?.response.truncated).toBe(true)
  expect(snapshot.attempts[0]?.response.observedBytes).toBe(UPSTREAM_ATTEMPT_LIMITS.responsePrefix + 1)
})

test("one giant chunk retains only a 256 KiB copy and a one-byte overflow marks truncation", async () => {
  for (const length of [UPSTREAM_ATTEMPT_LIMITS.responsePrefix, UPSTREAM_ATTEMPT_LIMITS.responsePrefix + 1]) {
    const collector = new UpstreamExchangeCollector()
    const attempt = begin(collector)
    if (!attempt) throw new Error("attempt omitted")
    const giant = bytes(length)
    const stream = attempt.observeResponse(200, [], new ReadableStream({ start(controller) { controller.enqueue(giant); controller.close() } }))
    expect((await new Response(stream).arrayBuffer()).byteLength).toBe(length)
    const body = collector.finish().attempts[0]?.response
    expect(body?.capturedBytes).toBe(UPSTREAM_ATTEMPT_LIMITS.responsePrefix)
    expect(body?.observedBytes).toBe(length)
    expect(body?.truncated).toBe(length > UPSTREAM_ATTEMPT_LIMITS.responsePrefix)
  }
})

test("prepared request stays untruncated at 64 KiB and truncates one byte over", () => {
  for (const length of [UPSTREAM_ATTEMPT_LIMITS.requestPrefix, UPSTREAM_ATTEMPT_LIMITS.requestPrefix + 1]) {
    const collector = new UpstreamExchangeCollector()
    const attempt = begin(collector)
    if (!attempt) throw new Error("attempt omitted")
    attempt.observePreparedRequest({ prefix: bytes(length), totalBytes: length })
    const request = collector.finish().attempts[0]?.request
    expect(request?.source).toBe("prepared")
    expect(request?.capturedBytes).toBe(UPSTREAM_ATTEMPT_LIMITS.requestPrefix)
    expect(request?.observedBytes).toBe(length)
    expect(request?.truncated).toBe(length > UPSTREAM_ATTEMPT_LIMITS.requestPrefix)
  }
})

test("base64 prefixes omit page padding at binary and capture boundaries", async () => {
  const lengths = [0, 1, 2, 3, 4095, 4096, 4097, 8191, 8192, 8193, 65535, 65536, 65537, 262143, 262144, 262145]
  for (const length of lengths) {
    const input = Uint8Array.from({ length }, (_, index) => (index * 31 + 17) % 256)
    const collector = new UpstreamExchangeCollector()
    const attempt = begin(collector)
    if (!attempt) throw new Error("attempt omitted")
    attempt.observePreparedRequest({ prefix: input, totalBytes: length })
    const stream = attempt.observeResponse(200, [], new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(input.subarray(0, 3))
        controller.enqueue(input.subarray(3, 4097))
        controller.enqueue(input.subarray(4097))
        controller.close()
      },
    }))
    await new Response(stream).arrayBuffer()
    const snapshot = collector.finish()
    const item = snapshot.attempts[0]
    if (!item) throw new Error("snapshot omitted")
    for (const [body, limit] of [[item.request, UPSTREAM_ATTEMPT_LIMITS.requestPrefix], [item.response, UPSTREAM_ATTEMPT_LIMITS.responsePrefix]] as const) {
      const decoded = Uint8Array.from(atob(body.prefixBase64), char => char.charCodeAt(0))
      expect(decoded).toEqual(input.subarray(0, limit))
      expect(body.capturedBytes).toBe(Math.min(length, limit))
      expect(body.totalBytes).toBe(length)
      expect(body.truncated).toBe(length > limit)
    }
    expect(safeUpstreamExchangesForPersistence(snapshot)).toEqual(snapshot)
  }
})

test("base64 preserves a partial final page when the aggregate byte budget is exhausted", async () => {
  const collector = new UpstreamExchangeCollector()
  const input = Uint8Array.from({ length: UPSTREAM_ATTEMPT_LIMITS.responsePrefix + 1 }, (_, index) => index % 256)
  for (let index = 0; index < 4; index++) {
    const attempt = begin(collector)
    if (!attempt) throw new Error("attempt omitted")
    attempt.observePreparedRequest({ prefix: input.subarray(0, 17), totalBytes: 17 })
    const stream = attempt.observeResponse(200, [], new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(input); controller.close() },
    }))
    await new Response(stream).arrayBuffer()
  }
  const snapshot = collector.finish()
  expect(snapshot.capturedBodyBytes).toBe(UPSTREAM_ATTEMPT_LIMITS.totalBodyBytes)
  const last = snapshot.attempts[3]
  if (!last) throw new Error("snapshot omitted")
  const remaining = UPSTREAM_ATTEMPT_LIMITS.totalBodyBytes - 4 * 17 - 3 * UPSTREAM_ATTEMPT_LIMITS.responsePrefix
  expect(remaining % 4096).toBe(4028)
  expect(last.response.capturedBytes).toBe(remaining)
  expect(last.response.truncated).toBe(true)
  expect(Uint8Array.from(atob(last.response.prefixBase64), char => char.charCodeAt(0))).toEqual(input.subarray(0, remaining))
  expect(safeUpstreamExchangesForPersistence(snapshot)).toEqual(snapshot)
})

test("16 KiB combined header and independent 64 KiB metadata budgets stop at exact byte limits", () => {
  const type: readonly [string, string] = ["Content-Type", "application/json"]
  const length: readonly [string, string] = ["Content-Length", "999999999999999"]
  const exactHeaders = [...Array.from({ length: 7 }, () => type), ...Array.from({ length: 436 }, () => length)]
  const collector = new UpstreamExchangeCollector()
  for (let index = 0; index < 4; index++) {
    const headers = index < 3
      ? [...exactHeaders, type]
      : [...Array.from({ length: 33 }, () => type), ...Array.from({ length: 300 }, () => length), length]
    const attempt = collector.begin({ parentCallId: "call-1", upstreamId: "upstream-1", method: "POST", operation: "responses.create", requestHeaders: headers })
    expect(attempt).not.toBeNull()
  }
  const snapshot = collector.finish()
  expect(snapshot.metadataBytes).toBe(UPSTREAM_ATTEMPT_LIMITS.metadataBytes)
  expect(snapshot.metadataTruncated).toBe(true)
  expect(snapshot.attempts.map(item => item.omittedRequestHeaders)).toEqual([1, 1, 1, 1])
  expect(snapshot.attempts.slice(0, 3).map(item => item.requestHeaders.length)).toEqual([443, 443, 443])
  expect(snapshot.attempts[3]?.requestHeaders.length).toBe(333)
})

test("native and iterable headers publish the same ordered sanitized metadata and owned pairs", () => {
  const requestHeaders = new Headers({
    Authorization: "private", "Content-Type": "APPLICATION/JSON; token=private",
    "Content-Length": "00012", "x-long": "x".repeat(129),
  })
  const responseHeaders = new Headers({ "Set-Cookie": "private", "Content-Type": "text/event-stream; token=private", "Content-Length": "000004" })
  const snapshots = [true, false].map(native => {
    const collector = new UpstreamExchangeCollector(Number.MAX_SAFE_INTEGER)
    const attempt = collector.begin({
      parentCallId: "call-1", upstreamId: "upstream-1", method: "POST", operation: "responses.create",
      requestHeaders: native ? requestHeaders : requestHeaders.entries(),
    })
    if (!attempt) throw new Error("attempt omitted")
    attempt.observeResponse(200, native ? responseHeaders : responseHeaders.entries(), null)
    return collector.finish(Number.MAX_SAFE_INTEGER)
  })
  expect(snapshots[0]).toEqual(snapshots[1])
  for (const snapshot of snapshots) {
    expect(snapshot.attempts[0]).toMatchObject({
      requestHeaders: [["content-length", "12"], ["content-type", "application/json"]],
      responseHeaders: [["content-length", "4"], ["content-type", "text/event-stream"]],
      omittedRequestHeaders: 2, omittedResponseHeaders: 1,
    })
    expect(snapshot.metadataBytes).toBe(1144)
    expect(snapshot.metadataTruncated).toBe(false)
    expect(JSON.stringify(snapshot)).not.toContain("private")
    expect(safeUpstreamExchangesForPersistence(snapshot)).toEqual(snapshot)
  }
  requestHeaders.set("content-type", "text/plain")
  responseHeaders.delete("content-length")
  expect(snapshots[0]?.attempts[0]?.requestHeaders).toEqual([["content-length", "12"], ["content-type", "application/json"]])
  expect(snapshots[0]?.attempts[0]?.responseHeaders).toEqual([["content-length", "4"], ["content-type", "text/event-stream"]])
})

test("native header subclasses cannot replace owned fields with spoofed iteration", () => {
  class NativeHeaders extends Headers {}
  const headers = new NativeHeaders({ "Content-Type": "application/json", Authorization: "private" })
  Object.defineProperties(headers, {
    [Symbol.iterator]: { value: function* () { yield ["content-type", "text/plain"] } },
    forEach: { value: () => { throw new Error("spoofed visitation") } },
  })
  const collector = new UpstreamExchangeCollector()
  const attempt = collector.begin({ parentCallId: "call-1", upstreamId: "upstream-1", method: "POST", requestHeaders: headers })
  if (!attempt) throw new Error("attempt omitted")
  attempt.observeResponse(200, headers, null)
  expect(collector.finish().attempts[0]).toMatchObject({
    requestHeaders: [["content-type", "application/json"]], responseHeaders: [["content-type", "application/json"]],
    omittedRequestHeaders: 1, omittedResponseHeaders: 1,
  })
})

for (const overflow of [0, 1, 1024]) {
  test(`saturated prefix forwards the suffix and counts true EOF with overflow=${overflow}`, async () => {
    const collector = new UpstreamExchangeCollector()
    const attempt = begin(collector)
    if (!attempt) throw new Error("attempt omitted")
    let index = -1
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index++ === -1) controller.enqueue(bytes(UPSTREAM_ATTEMPT_LIMITS.responsePrefix))
        else if (index <= overflow) controller.enqueue(Uint8Array.of(index % 256))
        else controller.close()
      },
    }, { highWaterMark: 0 })
    const forwarded = new Uint8Array(await new Response(attempt.observeResponse(200, [], source)).arrayBuffer())
    expect(forwarded.byteLength).toBe(UPSTREAM_ATTEMPT_LIMITS.responsePrefix + overflow)
    expect(forwarded.subarray(0, UPSTREAM_ATTEMPT_LIMITS.responsePrefix)).toEqual(bytes(UPSTREAM_ATTEMPT_LIMITS.responsePrefix))
    expect(Array.from(forwarded.subarray(UPSTREAM_ATTEMPT_LIMITS.responsePrefix))).toEqual(Array.from({ length: overflow }, (_, n) => (n + 1) % 256))
    const snapshot = collector.finish()
    expect(snapshot.attempts[0]?.response).toMatchObject({
      terminal: "eof", capturedBytes: UPSTREAM_ATTEMPT_LIMITS.responsePrefix,
      observedBytes: UPSTREAM_ATTEMPT_LIMITS.responsePrefix + overflow,
      totalBytes: UPSTREAM_ATTEMPT_LIMITS.responsePrefix + overflow, truncated: overflow > 0,
    })
    expect(atob(snapshot.attempts[0]?.response.prefixBase64 ?? "")).toBe("A".repeat(UPSTREAM_ATTEMPT_LIMITS.responsePrefix))
    expect(safeUpstreamExchangesForPersistence(snapshot)).toEqual(snapshot)
  })
}

test("another attempt can exhaust the shared budget between this response's demanded pulls", async () => {
  const collector = new UpstreamExchangeCollector()
  const subject = begin(collector)
  if (!subject) throw new Error("attempt omitted")
  let pulls = 0
  const source = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulls++ === 0) controller.enqueue(Uint8Array.of(9))
      else if (pulls === 2) controller.enqueue(Uint8Array.of(8, 7))
      else controller.close()
    },
  }, { highWaterMark: 0 })
  const reader = subject.observeResponse(200, [], source)?.getReader()
  if (!reader) throw new Error("reader expected")
  expect((await reader.read()).value).toEqual(Uint8Array.of(9))
  for (let index = 0; index < 4; index++) {
    const other = begin(collector)
    if (!other) throw new Error("attempt omitted")
    await new Response(other.observeResponse(200, [], new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(bytes(UPSTREAM_ATTEMPT_LIMITS.responsePrefix)); controller.close() },
    }))).arrayBuffer()
  }
  expect((await reader.read()).value).toEqual(Uint8Array.of(8, 7))
  expect((await reader.read()).done).toBe(true)
  reader.releaseLock()
  const snapshot = collector.finish()
  expect(snapshot.capturedBodyBytes).toBe(UPSTREAM_ATTEMPT_LIMITS.totalBodyBytes)
  expect(snapshot.attempts[0]?.response).toMatchObject({ capturedBytes: 1, prefixBase64: "CQ==", observedBytes: 3, totalBytes: 3, terminal: "eof", truncated: true })
  expect(snapshot.attempts[4]?.response.capturedBytes).toBe(UPSTREAM_ATTEMPT_LIMITS.responsePrefix - 1)
  expect(safeUpstreamExchangesForPersistence(snapshot)).toEqual(snapshot)
})

for (const terminal of ["cancelled", "read_error", "not_consumed"] as const) {
  test(`saturated prefix preserves ${terminal} after a pending source read`, async () => {
    const collector = new UpstreamExchangeCollector()
    const attempt = begin(collector)
    if (!attempt) throw new Error("attempt omitted")
    let pulls = 0
    let cancelled: unknown
    const pendingSource = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>()
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulls++ === 0) controller.enqueue(bytes(UPSTREAM_ATTEMPT_LIMITS.responsePrefix))
        else pendingSource.resolve(controller)
      },
      cancel(reason) { cancelled = reason },
    }, { highWaterMark: 0 })
    const reader = attempt.observeResponse(200, [], source)?.getReader()
    if (!reader) throw new Error("reader expected")
    expect((await reader.read()).value?.byteLength).toBe(UPSTREAM_ATTEMPT_LIMITS.responsePrefix)
    const pendingRead = reader.read()
    const controller = await pendingSource.promise
    if (terminal === "read_error") {
      controller.error(new Error("late source failure"))
      await expect(pendingRead).rejects.toThrow("late source failure")
    } else {
      if (terminal === "not_consumed") collector.finish()
      await reader.cancel("stop after prefix")
      expect((await pendingRead).done).toBe(true)
      expect(cancelled).toBe("stop after prefix")
    }
    reader.releaseLock()
    expect(source.locked).toBe(false)
    const snapshot = collector.finish()
    expect(snapshot.attempts[0]?.response).toMatchObject({
      terminal, capturedBytes: UPSTREAM_ATTEMPT_LIMITS.responsePrefix,
      observedBytes: UPSTREAM_ATTEMPT_LIMITS.responsePrefix, totalBytes: null, truncated: false,
    })
    expect(snapshot.attempts[0]?.errorCategory).toBe(terminal === "read_error" ? "read" : null)
    expect(safeUpstreamExchangesForPersistence(snapshot)).toEqual(snapshot)
  })
}

test("read failure after a prefix leaves observed bytes and an unknown total", async () => {
  const collector = new UpstreamExchangeCollector()
  const attempt = begin(collector)
  if (!attempt) throw new Error("attempt omitted")
  let pulls = 0
  const stream = attempt.observeResponse(200, [], new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulls++ === 0) controller.enqueue(Uint8Array.of(1, 2, 3))
      else controller.error(new Error("token-bearing read error"))
    },
  }))
  await expect(new Response(stream).arrayBuffer()).rejects.toThrow()
  const body = collector.finish().attempts[0]?.response
  expect(body?.terminal).toBe("read_error")
  expect(body?.observedBytes).toBe(3)
  expect(body?.totalBytes).toBeNull()
  expect(body?.prefixBase64).toBe("AQID")
  expect(JSON.stringify(collector.finish())).not.toContain("token-bearing")
})

test("diagnostic prefix copy failure does not fail or consume the forwarded response", async () => {
  class DiagnosticCopyFault extends Uint8Array {
    override subarray(_start?: number, _end?: number): Uint8Array {
      throw new Error("diagnostic copy failed")
    }
  }
  const collector = new UpstreamExchangeCollector()
  const attempt = begin(collector)
  if (!attempt) throw new Error("attempt omitted")
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new DiagnosticCopyFault([1, 2, 3]))
      controller.enqueue(Uint8Array.of(4, 5))
      controller.close()
    },
  })
  const wrapped = attempt.observeResponse(200, [], source)
  expect(Array.from(new Uint8Array(await new Response(wrapped).arrayBuffer()))).toEqual([1, 2, 3, 4, 5])
  const response = collector.finish().attempts[0]?.response
  expect(response?.terminal).toBe("eof")
  expect(response?.observedBytes).toBe(5)
  expect(response?.totalBytes).toBe(5)
  expect(response?.capturedBytes).toBe(0)
  expect(response?.truncated).toBe(true)
  expect(safeUpstreamExchangesForPersistence(collector.finish()).attempts).toHaveLength(1)
})

test("partially copied diagnostic prefix remains globally charged when a later copy faults", async () => {
  class PartialCopyFault extends Uint8Array {
    private copies = 0
    override subarray(start?: number, end?: number): Uint8Array {
      if (this.copies++ > 0) throw new Error("later diagnostic copy failed")
      return super.subarray(start, end)
    }
  }
  const collector = new UpstreamExchangeCollector()
  const attempt = begin(collector)
  if (!attempt) throw new Error("attempt omitted")
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new PartialCopyFault(bytes(5000)))
      controller.enqueue(Uint8Array.of(2))
      controller.close()
    },
  })
  const forwarded = new Uint8Array(await new Response(attempt.observeResponse(200, [], source)).arrayBuffer())
  expect(forwarded.byteLength).toBe(5001)
  expect(forwarded[0]).toBe(65)
  expect(forwarded[4999]).toBe(65)
  expect(forwarded[5000]).toBe(2)
  const snapshot = collector.finish()
  expect(snapshot.capturedBodyBytes).toBe(4096)
  expect(snapshot.attempts[0]?.response).toMatchObject({ terminal: "eof", observedBytes: 5001, totalBytes: 5001, capturedBytes: 4096, truncated: true })
  expect(atob(snapshot.attempts[0]?.response.prefixBase64 ?? "")).toHaveLength(4096)
  expect(safeUpstreamExchangesForPersistence(snapshot).capturedBodyBytes).toBe(4096)
})

test("many tiny SSE chunks stay in fetch-body form and malformed bytes remain lossless", async () => {
  const payload = new TextEncoder().encode("data: {\"x\":1}\n\ndata: {broken\n\n")
  const all = Uint8Array.from([...payload, 0xff])
  let pulls = 0
  const source = new ReadableStream<Uint8Array>({
    pull(controller) { if (pulls < all.length) controller.enqueue(all.subarray(pulls++, pulls)); else controller.close() },
  })
  const collector = new UpstreamExchangeCollector()
  const attempt = begin(collector)
  if (!attempt) throw new Error("attempt omitted")
  const body = attempt.observeResponse(200, [], source)
  expect(Array.from(new Uint8Array(await new Response(body).arrayBuffer()))).toEqual(Array.from(all))
  expect(collector.finish().attempts[0]?.response.prefixBase64).toBe(btoa(String.fromCharCode(...all)))
})

test("never-read, cancellation, no-body, fetch failure and read failure remain distinct", async () => {
  const collector = new UpstreamExchangeCollector()
  let cancelled = false
  const unread = begin(collector)
  if (!unread) throw new Error("attempt omitted")
  unread.observeResponse(429, [], new ReadableStream({ cancel() { cancelled = true } }))
  const noBody = begin(collector)
  if (!noBody) throw new Error("attempt omitted")
  noBody.observeResponse(204, [], null)
  const fetchFailure = begin(collector)
  if (!fetchFailure) throw new Error("attempt omitted")
  fetchFailure.fetchError("network")
  const readFailure = begin(collector)
  if (!readFailure) throw new Error("attempt omitted")
  const broken = readFailure.observeResponse(200, [], new ReadableStream({ pull(controller) { controller.error(new Error("secret")) } }))
  await expect(new Response(broken).arrayBuffer()).rejects.toThrow("secret")
  const snapshot = collector.finish()
  expect(snapshot.attempts.map(a => a.response.terminal)).toEqual(["not_consumed", "eof", "fetch_error", "read_error"])
  expect(snapshot.attempts[0]?.response.totalBytes).toBeNull()
  expect(snapshot.attempts[1]?.response.totalBytes).toBe(0)
  expect(snapshot.attempts[3]?.errorCategory).toBe("read")
  expect(JSON.stringify(snapshot)).not.toContain("secret")
  expect(cancelled).toBe(false)
})

test("consumer cancellation forwards to source and releases its reader", async () => {
  const collector = new UpstreamExchangeCollector()
  let cancelReason: unknown
  const source = new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(Uint8Array.of(1)) },
    cancel(reason) { cancelReason = reason },
  })
  const attempt = begin(collector)
  if (!attempt) throw new Error("attempt omitted")
  const wrapped = attempt.observeResponse(500, [], source)
  const reader = wrapped?.getReader()
  await reader?.read()
  await reader?.cancel("stop")
  expect(cancelReason).toBe("stop")
  expect(source.locked).toBe(false)
  expect(collector.finish().attempts[0]?.response.terminal).toBe("cancelled")
  expect(collector.finish().attempts[0]?.response.totalBytes).toBeNull()
})

test("cancel during a pending read leaves total unknown and earlier attempts persistable", async () => {
  const collector = new UpstreamExchangeCollector()
  const earlier = begin(collector)
  if (!earlier) throw new Error("attempt omitted")
  const earlierSource = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(Uint8Array.of(9)); controller.close() },
  })
  expect(Array.from(new Uint8Array(await new Response(earlier.observeResponse(200, [], earlierSource)).arrayBuffer()))).toEqual([9])

  let cancelReason: unknown
  const pending = begin(collector)
  if (!pending) throw new Error("attempt omitted")
  const source = new ReadableStream<Uint8Array>({
    pull() {},
    cancel(reason) { cancelReason = reason },
  })
  const reader = pending.observeResponse(429, [], source)?.getReader()
  const read = reader?.read()
  await Promise.resolve()
  await reader?.cancel("stop pending")
  await read

  expect(cancelReason).toBe("stop pending")
  expect(source.locked).toBe(false)
  const snapshot = collector.finish()
  expect(snapshot.attempts[0]?.response).toMatchObject({ terminal: "eof", totalBytes: 1, prefixBase64: "CQ==" })
  expect(snapshot.attempts[1]).toMatchObject({ errorCategory: null, response: { terminal: "cancelled", observedBytes: 0, totalBytes: null } })
  expect(safeUpstreamExchangesForPersistence(snapshot).attempts).toHaveLength(2)
})

test("two collectors retain independent owners and omit arbitrary URL and header values", () => {
  const first = new UpstreamExchangeCollector()
  const second = new UpstreamExchangeCollector()
  const a = begin(first)
  const b = second.begin({ parentCallId: "call-2", upstreamId: "upstream-2", method: "POST", operation: "custom/secret", url: "https://token@host/secret", requestHeaders: [["X-Token", "first-secret"]] })
  a?.observePreparedRequest({ prefix: Uint8Array.of(1), totalBytes: 1 })
  b?.observePreparedRequest({ prefix: Uint8Array.of(2), totalBytes: 1 })
  expect(first.finish().attempts[0]?.request.prefixBase64).toBe("AQ==")
  expect(second.finish().attempts[0]?.request.prefixBase64).toBe("Ag==")
  expect(second.finish().attempts[0]?.operation).toBe("url_omitted")
  expect(JSON.stringify(second.finish())).not.toContain("secret")
})
