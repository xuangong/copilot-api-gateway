import { expect, test } from "bun:test"
import { llmEventResult } from "@vibe-llm/protocols/common"
import { traverseTranslation } from "./traverse-translation.ts"
import { getTranslator } from "../../dispatch/translator-registry.ts"

const identity = { incomingModel: "m", model: "m", upstream: "u", modelKey: "m", cost: null }

async function* emptyFrames() {}
async function* chunks(items: unknown[]) { for (const item of items) yield item }

test("gateway traversal retains allowed custom identity across JSON and SSE after source mutation", async () => {
  const translator = getTranslator("responses", "chat_completions")
  if (!translator) throw new Error("missing translator")
  const sourcePayload: Record<string, unknown> = {
    model: "m", input: "q", tools: [
      { type: "custom", name: "selected", format: { type: "text" } },
      { type: "custom", name: "unselected" },
    ],
    tool_choice: { type: "allowed_tools", mode: "auto", tools: [{ type: "custom", name: "selected" }] },
  }
  let upstreamPayload: Record<string, unknown> | undefined
  const result = await traverseTranslation({
    sourcePayload, sourceProtocol: "responses", hubProtocol: "chat_completions", translator,
    innerAttempt: async args => {
      upstreamPayload = args.payload
      const firstTool = (sourcePayload.tools as Array<Record<string, unknown>>)[0]
      if (!firstTool) throw new Error("missing first tool")
      firstTool.name = "changed"
      return llmEventResult(emptyFrames(), identity)
    },
    inheritedHeaders: {}, inheritedTelemetryCtx: { incomingModel: "m" } as never, auth: {} as never,
  })
  if (result.type !== "events" || !result.translateBody || !result.translateEvents) throw new Error("missing translated result")
  expect(upstreamPayload?.tools).toMatchObject([{ function: { name: "selected" } }])
  const body = await result.translateBody({ id: "r", choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [
    { id: "a", type: "function", function: { name: "selected", arguments: '{"input":"yes"}' } },
    { id: "b", type: "function", function: { name: "unselected", arguments: "{}" } },
  ] }, finish_reason: "tool_calls" }] }, { signal: new AbortController().signal }) as Record<string, unknown>
  expect(body.output).toMatchObject([{ type: "custom_tool_call", name: "selected", input: "yes" }, { type: "function_call", name: "unselected" }])
  expect(body.tools).toMatchObject([{ type: "custom", name: "selected" }, { type: "custom", name: "unselected" }])
  const events: Array<Record<string, unknown>> = []
  for await (const event of result.translateEvents(chunks([
    { id: "r", model: "m", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "a", function: { name: "selected", arguments: '{"input":"yes"}' } }] }, finish_reason: "tool_calls" }] },
  ]), { signal: new AbortController().signal })) events.push(event as Record<string, unknown>)
  expect(events.find(event => event.type === "response.output_item.done")?.item).toMatchObject({ type: "custom_tool_call", name: "selected", input: "yes" })
  expect((events.find(event => event.type === "response.completed")?.response as Record<string, unknown>).output).toMatchObject([{ type: "custom_tool_call", name: "selected", input: "yes" }])
})

test("gateway Messages pair uses selected custom kind for JSON and stream outputs", async () => {
  const translator = getTranslator("responses", "messages")
  if (!translator) throw new Error("missing translator")
  const result = await traverseTranslation({
    sourcePayload: { model: "m", input: "q", tools: [{ type: "custom", name: "selected" }] },
    sourceProtocol: "responses", hubProtocol: "messages", translator,
    innerAttempt: async () => llmEventResult(emptyFrames(), identity),
    inheritedHeaders: {}, inheritedTelemetryCtx: { incomingModel: "m" } as never, auth: {} as never,
  })
  if (result.type !== "events" || !result.translateBody || !result.translateEvents) throw new Error("missing translated result")
  const body = await result.translateBody({ id: "r", model: "m", content: [{ type: "tool_use", id: "a", name: "selected", input: { input: "yes" } }], usage: { input_tokens: 0, output_tokens: 0 } }, { signal: new AbortController().signal }) as Record<string, unknown>
  expect(body.output).toMatchObject([{ type: "custom_tool_call", name: "selected", input: "yes" }])
  const events: Array<Record<string, unknown>> = []
  for await (const event of result.translateEvents(chunks([
    { type: "message_start", message: { id: "r", model: "m" } },
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "a", name: "selected" } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"input":"yes"}' } },
    { type: "content_block_stop", index: 0 }, { type: "message_stop" },
  ]), { signal: new AbortController().signal })) events.push(event as Record<string, unknown>)
  expect(events.find(event => event.type === "response.output_item.done")?.item).toMatchObject({ type: "custom_tool_call", name: "selected", input: "yes" })
  expect((events.find(event => event.type === "response.completed")?.response as Record<string, unknown>).output).toMatchObject([{ type: "custom_tool_call", name: "selected", input: "yes" }])
})

test("gateway Messages stream never completes an unclosed custom block", async () => {
  const translator = getTranslator("responses", "messages")
  if (!translator) throw new Error("missing translator")
  const result = await traverseTranslation({
    sourcePayload: { model: "m", input: "q", tools: [{ type: "custom", name: "selected" }] },
    sourceProtocol: "responses", hubProtocol: "messages", translator,
    innerAttempt: async () => llmEventResult(emptyFrames(), identity),
    inheritedHeaders: {}, inheritedTelemetryCtx: { incomingModel: "m" } as never, auth: {} as never,
  })
  if (result.type !== "events" || !result.translateEvents) throw new Error("missing translated result")
  const events: Array<Record<string, unknown>> = []
  for await (const event of result.translateEvents(chunks([
    { type: "message_start", message: { id: "r", model: "m" } },
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "a", name: "selected" } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"input":"partial' } },
    { type: "message_stop" },
  ]), { signal: new AbortController().signal })) events.push(event as Record<string, unknown>)
  expect(events.some(event => event.type === "error")).toBe(true)
  expect(events.some(event => event.type === "response.completed")).toBe(false)
})

test("gateway Messages stream reports truncated custom block without message_stop", async () => {
  const translator = getTranslator("responses", "messages")
  if (!translator) throw new Error("missing translator")
  const result = await traverseTranslation({
    sourcePayload: { model: "m", input: "q", tools: [{ type: "custom", name: "selected" }] },
    sourceProtocol: "responses", hubProtocol: "messages", translator,
    innerAttempt: async () => llmEventResult(emptyFrames(), identity),
    inheritedHeaders: {}, inheritedTelemetryCtx: { incomingModel: "m" } as never, auth: {} as never,
  })
  if (result.type !== "events" || !result.translateEvents) throw new Error("missing translated result")
  const events: Array<Record<string, unknown>> = []
  for await (const event of result.translateEvents(chunks([
    { type: "message_start", message: { id: "r", model: "m" } },
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "a", name: "selected" } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"input":"partial' } },
  ]), { signal: new AbortController().signal })) events.push(event as Record<string, unknown>)
  expect(events.find(event => event.type === "error")).toMatchObject({ code: "stream_truncated" })
  expect(events.some(event => event.type === "response.completed")).toBe(false)
})
