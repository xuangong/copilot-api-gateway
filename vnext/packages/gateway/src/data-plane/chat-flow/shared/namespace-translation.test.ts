import { expect, test } from "bun:test"
import { llmEventResult } from "@vibe-llm/protocols/common"
import { traverseTranslation } from "./traverse-translation"
import { getTranslator } from "../../dispatch/translator-registry"

const identity = { incomingModel: "m", model: "m", upstream: "u", modelKey: "m", cost: null }
async function* emptyFrames() {}
async function* chunks(items: unknown[]) { for (const item of items) yield item }

for (const hub of ["messages", "chat_completions"] as const) {
  for (const kind of ["function", "custom"] as const) {
    test(`${hub}: ${kind} namespace identity survives JSON, SSE and source mutation`, async () => {
      const translator = getTranslator("responses", hub)
      if (!translator) throw new Error("missing translator")
      const sourcePayload = { model: "m", input: "q", tools: [
        { type: "function", name: "agents_spawn" },
        { type: "namespace", name: "agents", tools: [{ type: kind, name: "spawn" }] },
      ], tool_choice: { type: "allowed_tools", mode: "required", tools: [{ type: "namespace", name: "agents" }] } }
      let sent: Record<string, unknown> | undefined
      const result = await traverseTranslation({
        sourcePayload, sourceProtocol: "responses", hubProtocol: hub, translator,
        innerAttempt: async args => {
          sent = args.payload
          const namespaced = sourcePayload.tools[1]
          if (!namespaced) throw new Error("missing namespace fixture")
          namespaced.name = "mutated"
          return llmEventResult(emptyFrames(), identity)
        }, inheritedHeaders: {}, inheritedTelemetryCtx: { incomingModel: "m" } as never, auth: {} as never,
      })
      expect(result.type).toBe("events")
      if (result.type !== "events" || !result.translateBody || !result.translateEvents) throw new Error("missing translated result")
      expect(sent?.tools).toMatchObject(hub === "messages" ? [{ name: "agents_spawn_2" }] : [{ function: { name: "agents_spawn_2" } }])
      const input = kind === "custom" ? { input: "echo hi" } : { x: 1 }
      const body = hub === "messages"
        ? { id: "r", model: "m", content: [{ type: "tool_use", id: "c", name: "agents_spawn_2", input }], usage: { input_tokens: 0, output_tokens: 0 } }
        : { id: "r", choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [{ id: "c", type: "function", function: { name: "agents_spawn_2", arguments: JSON.stringify(input) } }] }, finish_reason: "tool_calls" }] }
      const ctx = { signal: new AbortController().signal }
      const json = await result.translateBody(body, ctx) as Record<string, unknown>
      const wanted = { type: kind === "custom" ? "custom_tool_call" : "function_call", namespace: "agents", name: "spawn", call_id: "c",
        ...(kind === "custom" ? { input: "echo hi" } : { arguments: '{"x":1}' }) }
      expect(json.output).toMatchObject([wanted])
      if (hub === "chat_completions") expect(json.tools).toMatchObject([{ name: "agents_spawn" }, { type: "namespace", name: "agents" }])
      const upstream = hub === "messages" ? [
        { type: "message_start", message: { id: "r", model: "m" } },
        { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "c", name: "agents_spawn_2" } },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } },
        { type: "content_block_stop", index: 0 }, { type: "message_stop" },
      ] : [{ id: "r", model: "m", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c", function: { name: "agents_spawn_2", arguments: JSON.stringify(input) } }] }, finish_reason: "tool_calls" }] }]
      const events: Array<Record<string, unknown>> = []
      for await (const event of result.translateEvents(chunks(upstream), ctx)) events.push(event as Record<string, unknown>)
      expect(events.find(e => e.type === "response.output_item.added")?.item).toMatchObject({ namespace: "agents", name: "spawn" })
      expect(events.find(e => e.type === "response.output_item.done")?.item).toMatchObject(wanted)
      expect((events.find(e => e.type === "response.completed")?.response as Record<string, unknown>).output).toMatchObject([wanted])
      if (kind === "function") expect(events.find(e => e.type === "response.function_call_arguments.done")).toMatchObject({ name: "spawn" })
      else expect(events.find(e => e.type === "response.custom_tool_call_input.done")).not.toHaveProperty("name")
    })
  }
}

test("concurrent requests cannot share namespace mappings", async () => {
  const translator = getTranslator("responses", "messages")
  if (!translator) throw new Error("missing translator")
  const requests = await Promise.all([["a_b", "c"], ["a", "b_c"]].map(async ([namespace, name]) => ({ namespace, name,
    result: await traverseTranslation({
      sourcePayload: { model: "m", input: "q", tools: [{ type: "namespace", name: namespace, tools: [{ type: "function", name }] }] },
      sourceProtocol: "responses", hubProtocol: "messages", translator,
      innerAttempt: async () => llmEventResult(emptyFrames(), identity),
      inheritedHeaders: {}, inheritedTelemetryCtx: { incomingModel: "m" } as never, auth: {} as never,
    }),
  })))
  for (const { result, namespace, name } of requests) {
    expect(result.type).toBe("events")
    if (result.type !== "events" || !result.translateBody) throw new Error("missing translated result")
    const body = await result.translateBody({ id: "r", model: "m", content: [{ type: "tool_use", id: "c", name: "a_b_c", input: {} }], usage: { input_tokens: 0, output_tokens: 0 } }, { signal: new AbortController().signal }) as Record<string, unknown>
    expect(body.output).toMatchObject([{ namespace, name }])
  }
})

test("split Chat tool names do not expose partial namespace aliases", async () => {
  const translator = getTranslator("responses", "chat_completions")
  if (!translator) throw new Error("missing translator")
  const result = await traverseTranslation({
    sourcePayload: { model: "m", input: "q", tools: [{ type: "namespace", name: "agents", tools: [{ type: "function", name: "spawn" }] }] },
    sourceProtocol: "responses", hubProtocol: "chat_completions", translator,
    innerAttempt: async () => llmEventResult(emptyFrames(), identity),
    inheritedHeaders: {}, inheritedTelemetryCtx: { incomingModel: "m" } as never, auth: {} as never,
  })
  if (result.type !== "events" || !result.translateEvents) throw new Error("missing translated result")
  const events: Array<Record<string, unknown>> = []
  for await (const event of result.translateEvents(chunks([
    { id: "r", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c", function: { name: "agents_", arguments: "{" } }] }, finish_reason: null }] },
    { id: "r", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: "spawn", arguments: "}" } }] }, finish_reason: "tool_calls" }] },
  ]), { signal: new AbortController().signal })) events.push(event as Record<string, unknown>)
  expect(events.find(e => e.type === "response.output_item.added")?.item).toMatchObject({ name: "spawn", namespace: "agents" })
  expect(events.find(e => e.type === "response.output_item.done")?.item).toMatchObject({ name: "spawn", namespace: "agents", arguments: "{}" })
  expect(events.find(e => e.type === "response.function_call_arguments.done")).toMatchObject({ name: "spawn" })
})
