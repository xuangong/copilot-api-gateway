import { expect, test } from "bun:test"
import { eventFrame } from "@vibe-core/result"
import type { ResponsesStreamEvent } from "@vibe-llm/protocols/responses"
import { collectResponsesProtocolEventsToResult } from "../../../../src/data-plane/chat-flow/responses/events/reassemble"

// Adapted from reference copilot-gateway 8c9e722f0 (#712): a Responses `error`
// event keeps its message and code through JSON reassembly, and the following
// `response.failed` is still consumed (the stream is drained, not abandoned).
test("error event keeps message and code, and the following response.failed is consumed", async () => {
  const flat = { type: "error", code: "rate_limit_exceeded", message: "Limit reached" } as unknown as ResponsesStreamEvent
  const failed = { type: "response.failed", response: { id: "r", object: "response", model: "m", status: "failed", output: [], error: { code: "rate_limit_exceeded", message: "Limit reached" } } } as unknown as ResponsesStreamEvent
  let consumedFailed = false
  const frames = (async function* () {
    yield eventFrame(flat)
    consumedFailed = true
    yield eventFrame(failed)
  })()
  const caught: unknown = await collectResponsesProtocolEventsToResult(frames).catch((e: unknown) => e)
  expect(caught).toBeInstanceOf(Error)
  expect((caught as Error).message).toContain("Limit reached")
  expect((caught as Error).cause).toBe(flat)
  expect(consumedFailed).toBe(true)
})

test("nested error envelope still reports its message", async () => {
  const nested = { type: "error", error: { code: "x", message: "nested detail" } } as unknown as ResponsesStreamEvent
  const caught: unknown = await collectResponsesProtocolEventsToResult((async function* () { yield eventFrame(nested) })()).catch((e: unknown) => e)
  expect((caught as Error).message).toContain("nested detail")
  expect((caught as Error).cause).toBe(nested)
})
