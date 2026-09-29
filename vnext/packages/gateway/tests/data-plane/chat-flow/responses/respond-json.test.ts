import { beforeEach, expect, spyOn, test } from "bun:test"
import { eventFrame } from "@vibe-core/result"
import { llmEventResult } from "@vibe-llm/protocols/common"
import type { ResponsesStreamEvent } from "@vibe-llm/protocols/responses"
import { renderResponsesTurn } from "../../../../src/data-plane/chat-flow/responses/respond"
import { createResponsesTurn, type ResponsesTurn, type ResponsesTurnMetadata } from "../../../../src/data-plane/chat-flow/responses/turn"
import { setupTestPlatform } from "../../../_setup-platform"

beforeEach(() => setupTestPlatform())

function renderBody(body: unknown, metadata: ResponsesTurnMetadata = { status: 200 }, terminal = true): Promise<Response> {
  const turn: ResponsesTurn = {
    events: (async function* () {
      if (terminal) yield { type: "response.completed", response: body } as ResponsesStreamEvent
    })(),
    ready: Promise.resolve({ ...metadata, body }),
    completion: Promise.resolve({ outcome: "completed", cleanupComplete: true }),
    abortController: new AbortController(), wantsStream: false, mergedInputItems: [],
    recordSentPayloadBytes() {},
  }
  return renderResponsesTurn(turn)
}

test("JSON transport serializes large output once without an extra full UTF-8 buffer", async () => {
  const payload = "é中😀".repeat(128 * 1024)
  let serializations = 0
  const body = { toJSON() { serializations++; return { output: payload } } }
  const encode = TextEncoder.prototype.encode
  let fullEncodings = 0
  const observer = spyOn(TextEncoder.prototype, "encode").mockImplementation(function (input) {
    if ((input?.length ?? 0) > 64 * 1024) fullEncodings++
    return encode.call(this, input)
  })
  try {
    const response = await renderBody(body)
    expect(await response.json()).toEqual({ output: payload })
    expect(serializations).toBe(1)
    expect(fullEncodings).toBe(0)
  } finally { observer.mockRestore() }
})

test("JSON sent byte count includes Unicode and settles before dump finalization", async () => {
  let sentBytes = 0
  let finalizedBytes: number | undefined
  const body = { id: "unicode", status: "completed", output: [], text: "aé中😀\ud800" }
  const turn = createResponsesTurn(llmEventResult((async function* () {
    yield eventFrame({ type: "response.completed", response: body } as ResponsesStreamEvent)
  })(), { incomingModel: "test", model: "test", modelKey: "test", upstream: "test", cost: null }), {
    wantsStream: false, finalizeDump: true,
    dump: {
      frame() {}, success() {}, failed() {},
      recordSentPayloadBytes(size: number) { sentBytes += size },
      async finalizeTurn() { finalizedBytes = sentBytes },
    } as never,
  })
  const response = await renderResponsesTurn(turn)
  const wire = new Uint8Array(await response.arrayBuffer())
  await turn.completion
  expect(sentBytes).toBe(wire.byteLength)
  expect(finalizedBytes).toBe(wire.byteLength)
  expect(JSON.parse(new TextDecoder().decode(wire)).text).toBe(body.text)
})

test("JSON metadata fallback retains error status and headers", async () => {
  const response = await renderBody({ error: { message: "unavailable" } }, {
    status: 503, headers: new Headers({ "x-upstream": "retained", "content-length": "999" }),
  }, false)
  expect(response.status).toBe(503)
  expect(response.headers.get("x-upstream")).toBe("retained")
  expect(response.headers.get("content-type")).toBe("application/json")
  expect(response.headers.get("content-length")).toBeNull()
  expect(await response.json()).toEqual({ error: { message: "unavailable" } })
})

for (const terminal of [true, false]) {
  test(`JSON ${terminal ? "terminal" : "fallback"} preserves serialization errors`, async () => {
    const circular: { self?: unknown } = {}
    circular.self = circular
    await expect(renderBody(circular, { status: 200 }, terminal)).rejects.toThrow(TypeError)
    await expect(renderBody(1n, { status: 200 }, terminal)).rejects.toThrow(TypeError)
    // Preserve the platform's handling of values with no JSON representation.
    // Bun 1.3 returns an empty body; Workers rejects them.
    const native = Response.json(undefined)
    const response = await renderBody(undefined, { status: 200 }, terminal)
    expect(await response.text()).toBe(await native.text())
  })
}

test("JSON cancellation replaces a terminal already serialized for delivery", async () => {
  const abortController = new AbortController()
  const response = await renderResponsesTurn({
    events: (async function* () {
      yield { type: "response.completed", response: { status: "completed" } } as ResponsesStreamEvent
    })(),
    ready: Promise.resolve({ status: 200 }),
    completion: Promise.resolve({ outcome: "cancelled", cleanupComplete: true }),
    abortController, wantsStream: false, mergedInputItems: [],
    recordSentPayloadBytes() { abortController.abort() },
  })
  expect(response.status).toBe(502)
  expect(await response.json()).toEqual({ error: { type: "api_error", message: "Response cancelled." } })
})
