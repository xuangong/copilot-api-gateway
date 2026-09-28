import { expect, test } from "bun:test"
import type { ProtocolFrame } from "@vibe-core/result"
import { llmEventResult, type LlmEventResult } from "@vibe-llm/protocols/common"
import { translateChatToResponsesEvents } from "@vibe-llm/translate/responses-via-chat-completions"
import { translateChatSSEToMessagesEvents } from "@vibe-llm/translate/messages-via-chat-completions"
import { translateResponsesToChatSSE } from "@vibe-llm/translate/chat-completions-via-responses"
import { translateResponsesEventsToMessagesEvents } from "@vibe-llm/translate/messages-via-responses"
import { respondResponses } from "../../../../src/data-plane/chat-flow/responses/respond"
import { respondMessages } from "../../../../src/data-plane/chat-flow/messages/respond"
import { respondChatCompletions } from "../../../../src/data-plane/chat-flow/chat-completions/respond"
import { withUpstreamTelemetry } from "../../../../src/data-plane/chat-flow/shared/upstream-telemetry"
import { parseResponsesStream } from "@vibe-llm/protocols/responses"

const identity = { incomingModel: "m", model: "m", upstream: "test", modelKey: "m", cost: null }
async function* frames(events: unknown[], thrown = false): AsyncGenerator<ProtocolFrame<never>> {
  for (const event of events) yield { type: "event", event: event as never }
  if (thrown) throw new Error("iterator failure")
}
const renderers = {
  responses: (result: LlmEventResult<ProtocolFrame<never>>) => respondResponses(result, { wantsStream: true }),
  messages: (result: LlmEventResult<ProtocolFrame<never>>) => respondMessages(result, { wantsStream: true }),
  chat_completions: (result: LlmEventResult<ProtocolFrame<never>>) => respondChatCompletions(result, { wantsStream: true, includeUsageChunk: true }),
}
for (const protocol of ["responses", "messages", "chat_completions"] as const) {
  for (const thrown of [false, true]) {
    test(`${protocol}: actual native wire surfaces ${thrown ? "iterator throw" : "premature EOF"} once`, async () => {
      const upstream = withUpstreamTelemetry(frames([], thrown), { protocol })
      const wire = await (await renderers[protocol](llmEventResult(upstream.events, identity))).text()
      expect(wire.match(/event: error/g)).toHaveLength(1)
      expect(wire).not.toContain("[DONE]")
      expect(wire).not.toContain("response.completed")
      expect(wire).not.toContain("message_stop")
      expect((await upstream.finalMetadata).failed).toBe(true)
    })
  }
}
test("native Responses wire withholds completion and snapshot after late error", async () => {
  let snapshots = 0
  const upstream = withUpstreamTelemetry(frames([
    { type: "response.completed", response: { id: "r", object: "response", model: "m", status: "completed", output: [] } },
    { type: "error", message: "late failure", code: "server_error" },
  ]), { protocol: "responses" })
  const response = await respondResponses(llmEventResult(upstream.events, identity), {
    wantsStream: true,
    onCompleted: async () => { snapshots++ },
  })
  const wire = await response.text()
  expect(wire).not.toContain("response.completed")
  expect(wire.match(/event: error/g)).toHaveLength(1)
  expect(snapshots).toBe(0)
})
for (const [target, translate] of [["responses", translateChatToResponsesEvents], ["messages", translateChatSSEToMessagesEvents]] as const) {
  test(`Chat to ${target} actual wire rejects EOF after finish without DONE`, async () => {
    const upstream = withUpstreamTelemetry(frames([{ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }]), { protocol: "chat_completions" })
    const result = llmEventResult(upstream.events, identity, undefined, undefined, undefined, translate)
    const wire = await (await renderers[target](result)).text()
    expect(wire.match(/event: error/g)).toHaveLength(1)
    expect(wire).not.toContain("response.completed")
    expect(wire).not.toContain("message_stop")
  })
}
for (const [target, translate] of [["chat_completions", translateResponsesToChatSSE], ["messages", translateResponsesEventsToMessagesEvents]] as const) {
  test(`Responses failure to ${target} actual wire emits one error and no success`, async () => {
    const upstream = withUpstreamTelemetry(frames([{ type: "response.failed", response: { error: { message: "failed upstream" } } }]), { protocol: "responses" })
    const result = llmEventResult(upstream.events, identity, undefined, undefined, undefined, translate)
    const wire = await (await renderers[target](result)).text()
    expect(wire.match(/event: error/g)).toHaveLength(1)
    expect(wire).not.toContain('"finish_reason":"stop"')
    expect(wire).not.toContain("message_stop")
    expect(wire).not.toContain("[DONE]")
  })
}
test("Responses error to Messages retains context-window classification", async () => {
  const upstream = withUpstreamTelemetry(frames([{ type: "error", code: "context_length_exceeded", message: "too long" }]), { protocol: "responses" })
  const result = llmEventResult(upstream.events, identity, undefined, undefined, undefined, translateResponsesEventsToMessagesEvents)
  const wire = await (await renderers.messages(result)).text()
  expect(wire).toContain('"type":"invalid_request_error"')
  expect(wire.match(/event: error/g)).toHaveLength(1)
})
test("truncated Responses parser releases readable stream lock", async () => {
  const body = new Response('event: response.created\ndata: {"type":"response.created","response":{"id":"r"}}\n\n').body
  if (!body) throw new Error("body missing")
  const upstream = withUpstreamTelemetry(parseResponsesStream(body), { protocol: "responses" })
  await expect((async () => { for await (const frame of upstream.events) void frame })()).rejects.toThrow("without")
  expect(body.locked).toBe(false)
})
