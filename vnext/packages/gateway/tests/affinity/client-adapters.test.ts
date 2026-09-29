import { expect, test } from "bun:test"
import { AffinityCodec, AFFINITY_MARKER, InvalidAffinityStateError } from "../../src/shared/affinity/carrier.ts"
import { analyzeAffinityRequest, stampAffinityItem } from "../../src/shared/affinity/analysis.ts"
import type { AffinityExecutionTarget } from "@vibe-llm/provider-llm"

const target: AffinityExecutionTarget = { provider: "custom", upstreamId: "up", upstreamIncarnation: "inc", credentialSubject: "subject", credentialRevision: "rev", model: "model" }
const codec = new AffinityCodec({ ownerId: "owner", apiKeyId: "key", version: 1, keyId: "kid", secret: new Uint8Array(32).fill(3) })

test("Chat authenticates canonical complete reasoning and projects all reasoning aliases together", async () => {
  const raw = { role: "assistant", content: "visible", reasoning_text: " \n ", reasoning_content: "ignored", reasoning_opaque: "raw" }
  const signed = await stampAffinityItem("chat_completions", raw, target, codec)
  expect(String(signed.reasoning_opaque).startsWith(AFFINITY_MARKER)).toBe(true)
  const plan = await analyzeAffinityRequest("chat_completions", { messages: [signed] }, codec)
  expect(plan.materialize(target)).toEqual({ messages: [raw] })
  expect(plan.materialize(undefined)).toEqual({ messages: [{ role: "assistant", content: "visible" }] })
  await expect(analyzeAffinityRequest("chat_completions", { messages: [{ ...signed, reasoning_text: "changed" }] }, codec)).rejects.toBeInstanceOf(InvalidAffinityStateError)
  const empty = await stampAffinityItem("chat_completions", { ...raw, reasoning_text: "" }, target, codec)
  expect((await analyzeAffinityRequest("chat_completions", { messages: [{ ...empty, reasoning_content: "different ignored" }] }, codec)).hasOwned).toBe(true)
})

for (const payload of [
  { refusal: "I cannot help" },
  { audio: { id: "audio_1", transcript: "spoken answer" } },
  { function_call: { name: "f", arguments: "{}" } },
  { extension_payload: { value: "preserved" } },
  { extension_payload: false },
  { extension_payload: null },
]) {
  test(`Chat optional reasoning projection preserves non-reasoning payload ${JSON.stringify(payload)}`, async () => {
    const remaining = { role: "assistant", content: null, ...payload }
    const raw = { ...remaining, reasoning_text: "thought", reasoning_content: "alias", reasoning: "alias", reasoning_items: [], reasoning_opaque: "raw" }
    const signed = await stampAffinityItem("chat_completions", raw, target, codec)
    const source = { messages: [signed, { role: "user", content: "next" }] }
    const original = structuredClone(source)
    const plan = await analyzeAffinityRequest("chat_completions", source, codec)
    expect(plan.classify(undefined)).toBe("degraded")
    expect(plan.materialize(undefined)).toEqual({ messages: [remaining, source.messages[1]] })
    expect(plan.materialize(target)).toEqual({ messages: [raw, source.messages[1]] })
    expect(source).toEqual(original)
  })
}

test("Chat optional reasoning projection still removes a reasoning-only assistant", async () => {
  for (const content of [undefined, null, ""]) {
    const raw = { role: "assistant", ...(content === undefined ? {} : { content }), reasoning_text: "thought", reasoning_opaque: "raw" }
    const signed = await stampAffinityItem("chat_completions", raw, target, codec)
    const source = { messages: [signed, { role: "user", content: "next" }] }
    const plan = await analyzeAffinityRequest("chat_completions", source, codec)
    expect(plan.materialize(undefined)).toEqual({ messages: [source.messages[1]] })
    expect(plan.materialize(target)).toEqual({ messages: [raw, source.messages[1]] })
  }
})

test("Gemini binds whole semantic Parts without position and treats signed tool state as required", async () => {
  const raw = { functionCall: { id: "call", name: "f", args: { signature: "business", encrypted_content: "business" } }, thoughtSignature: "opaque" }
  const signed = await stampAffinityItem("gemini", raw, target, codec)
  expect(String(signed.thoughtSignature).startsWith(AFFINITY_MARKER)).toBe(true)
  const plan = await analyzeAffinityRequest("gemini", { contents: [{ role: "model", parts: [{ text: "visible" }, signed] }] }, codec)
  expect(plan.hasRequiredOwned).toBe(true)
  expect(plan.classify(undefined)).toBe("unavailable")
  expect(plan.materialize(target)).toEqual({ contents: [{ role: "model", parts: [{ text: "visible" }, raw] }] })
  await expect(analyzeAffinityRequest("gemini", { contents: [{ role: "model", parts: [{ ...signed, functionCall: { ...raw.functionCall, id: "other" } }] }] }, codec)).rejects.toBeInstanceOf(InvalidAffinityStateError)
  const thought = await stampAffinityItem("gemini", { text: " \n ", thought: true, thoughtSignature: "sig" }, target, codec)
  expect((await analyzeAffinityRequest("gemini", { contents: [{ role: "model", parts: [thought, { text: "answer" }] }] }, codec)).materialize(undefined)).toEqual({ contents: [{ role: "model", parts: [{ text: "answer" }] }] })
})

import { AffinityEgress } from "../../src/shared/affinity/egress.ts"
import { eventFrame, doneFrame, type ProtocolFrame } from "@vibe-core/result"
import { translateChatToResponses } from "../../../translate/src/chat-completions-via-responses/request.ts"
import { translateChatToMessages } from "../../../translate/src/chat-completions-via-messages/request.ts"
import { translateMessagesToChatBody } from "../../../translate/src/chat-completions-via-messages/body.ts"
import { translateResponsesToChatBody } from "../../../translate/src/chat-completions-via-responses/body.ts"
import { translateChatToGeminiEvents } from "../../../translate/src/gemini-via-chat-completions/events.ts"
import { reassembleChatCompletions } from "../../src/data-plane/chat-flow/chat-completions/events/reassemble.ts"
import type { ChatCompletionsStreamEvent } from "@vibe-llm/protocols/chat"

async function* values<T>(input: T[]): AsyncGenerator<T> { yield* input }
const chunk = (index: number, delta: Record<string, unknown>, finish: string | null = null): ChatCompletionsStreamEvent => ({ id: "c", object: "chat.completion.chunk", model: "m", created: 1, choices: [{ index, delta, finish_reason: finish }] }) as ChatCompletionsStreamEvent

test("Chat egress aggregates split raw signatures per choice and preserves finish order", async () => {
  const context = { protocol: "chat_completions" as const, codec, analysis: await analyzeAffinityRequest("chat_completions", {}, codec), actual: target }
  const input: ProtocolFrame<ChatCompletionsStreamEvent>[] = [eventFrame(chunk(1, { reasoning_text: " \n", reasoning_opaque: "a" })), eventFrame(chunk(0, { reasoning_text: "other", reasoning_opaque: "other" }, "stop")), eventFrame(chunk(1, { reasoning_text: " ", reasoning_opaque: "b" }, "stop")), doneFrame()]
  const output = await Array.fromAsync(new AffinityEgress(context).chat(values(input)))
  const events = output.flatMap(frame => frame.type === "event" ? [frame.event] : [])
  const result = await reassembleChatCompletions(values(events))
  expect(result.choices.map(choice => choice.index)).toEqual([0, 1])
  for (const choice of result.choices) {
    expect(String(choice.message.reasoning_opaque).startsWith(AFFINITY_MARKER)).toBe(true)
    const plan = await analyzeAffinityRequest("chat_completions", { messages: [choice.message] }, codec)
    expect(plan.materialize(target)).toEqual({ messages: [{ ...choice.message, reasoning_opaque: choice.index === 1 ? "ab" : "other" }] })
  }
})

test("Chat request/body translations retain raw opaque and full whitespace", () => {
  const message = { role: "assistant" as const, content: "answer", reasoning_text: " \n ", reasoning_opaque: "opaque" }
  const request = { model: "m", messages: [message] }
  expect(translateChatToResponses(request).target.input).toContainEqual(expect.objectContaining({ type: "reasoning", encrypted_content: "opaque", summary: [{ type: "summary_text", text: " \n " }] }))
  expect(translateChatToMessages(request).messages).toContainEqual(expect.objectContaining({ content: expect.arrayContaining([{ type: "thinking", thinking: " \n ", signature: "opaque" }]) }))
  expect(translateResponsesToChatBody({ id: "r", output: [{ type: "reasoning", summary: [{ type: "summary_text", text: " \n " }], encrypted_content: "opaque" }] }).choices[0]?.message).toMatchObject({ reasoning_text: " \n ", reasoning_opaque: "opaque" })
  expect(translateMessagesToChatBody({ id: "r", type: "message", role: "assistant", model: "m", content: [{ type: "thinking", thinking: " \n ", signature: "opaque" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } }).choices[0]?.message).toMatchObject({ reasoning_text: " \n ", reasoning_opaque: "opaque" })
})

test("Gemini Chat bridge emits one complete signed thought Part after late signatures", async () => {
  const output = await Array.fromAsync(translateChatToGeminiEvents(values([chunk(2, { reasoning_text: " \n" }), chunk(2, { reasoning_text: " ", reasoning_opaque: "sig" }), chunk(2, {}, "stop")])))
  const parts = output.flatMap(event => "candidates" in event ? event.candidates?.flatMap(candidate => candidate.content?.parts ?? []) ?? [] : [])
  expect(parts).toEqual([{ text: " \n ", thought: true, thoughtSignature: "sig" }])
})

import { translateGeminiToMessages } from "../../../translate/src/gemini-via-messages/request.ts"
import { translateMessagesToGeminiEvents } from "../../../translate/src/gemini-via-messages/events.ts"
import { translateMessagesToGeminiBody } from "../../../translate/src/gemini-via-messages/body.ts"

test("Gemini Messages bridge preserves signed thought companion and tool ID in both directions", async () => {
  const input = { contents: [{ role: "model", parts: [{ thought: true, text: " \n ", thoughtSignature: "sig" }, { functionCall: { id: "call", name: "f", args: { signature: "business" } } }] }] }
  const request = translateGeminiToMessages(input, { model: "m" })
  expect(request.messages).toContainEqual(expect.objectContaining({ content: expect.arrayContaining([{ type: "thinking", thinking: " \n ", signature: "sig" }, expect.objectContaining({ type: "tool_use", id: "call", name: "f", input: { signature: "business" } })]) }))
  const message = { id: "msg", type: "message" as const, role: "assistant" as const, model: "m", content: [{ type: "thinking" as const, thinking: " \n ", signature: "sig" }], stop_reason: "end_turn" as const, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }
  expect(translateMessagesToGeminiBody(message, { model: "m" }).candidates?.[0]?.content?.parts).toEqual([{ text: " \n ", thought: true, thoughtSignature: "sig" }])
  const events = await Array.fromAsync(translateMessagesToGeminiEvents(values([{ type: "message_start", message }, { type: "content_block_start", index: 0, content_block: message.content[0] }, { type: "content_block_stop", index: 0 }, { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }, { type: "message_stop" }] as never[])))
  expect(events.flatMap(event => event.candidates?.flatMap(candidate => candidate.content?.parts ?? []) ?? [])).toEqual([{ text: " \n ", thought: true, thoughtSignature: "sig" }])
})

import { guardAffinityFrames } from "../../src/shared/affinity/egress.ts"
import { MAX_AFFINITY_PAYLOAD_BYTES } from "../../src/shared/affinity/carrier.ts"
import { selectAffinityCandidate } from "../../src/data-plane/shared/affinity-request.ts"
import type { LlmModelProvider, LlmProviderBinding } from "@vibe-llm/provider-llm"
import { translateMessagesToChatSSE } from "../../../translate/src/chat-completions-via-messages/events.ts"

test("required Gemini tool state cannot use any existing hub and never prepares a provider", async () => {
  let prepares = 0
  const part = await stampAffinityItem("gemini", { functionCall: { id: "a", name: "f", args: {} }, thoughtSignature: "sig" }, target, codec)
  const source = { contents: [{ role: "model", parts: [part] }] }
  const context = { protocol: "gemini" as const, codec, analysis: await analyzeAffinityRequest("gemini", source, codec) }
  for (const endpoint of ["chat_completions", "messages", "responses"] as const) {
    const provider: LlmModelProvider = { name: "fixture", kind: "custom", supportedEndpoints: [endpoint], getPricingForModelKey: () => null, getModels: async () => ({ object: "list", data: [] }), probe: async () => ({ ok: true }), fetch: async () => { throw new Error("must not infer") }, prepareAffinityExecution: async () => { prepares++; return target } }
    const binding: LlmProviderBinding = { kind: "custom", upstream: "up", enabledFlags: new Set(), model: { id: "m", endpoints: { [endpoint]: {} } }, provider }
    await expect(selectAffinityCandidate([{ binding, targetEndpoint: endpoint }], context, "m")).rejects.toThrow("No authorized compatible route")
  }
  expect(prepares).toBe(0)
})

test("Chat entrance guard closes an oversized split signature before translators buffer it", async () => {
  const context = { protocol: "chat_completions" as const, codec, analysis: await analyzeAffinityRequest("chat_completions", {}, codec), actual: target }
  let returned = false
  async function* upstream() {
    try {
      yield eventFrame(chunk(0, { reasoning_opaque: "a".repeat(MAX_AFFINITY_PAYLOAD_BYTES) }))
      yield eventFrame(chunk(0, { reasoning_opaque: "b" }))
      throw new Error("must cancel first")
    } finally { returned = true }
  }
  await expect(Array.fromAsync(guardAffinityFrames(upstream(), context))).rejects.toBeInstanceOf(InvalidAffinityStateError)
  expect(returned).toBe(true)
})

test("Messages Chat stream retains initial-only tool business fields without reading their names as opaque", async () => {
  const input = { signature: "ordinary", encrypted_content: "ordinary", nested: { type: "reasoning", fingerprint: "ordinary" } }
  const output = await Array.fromAsync(translateMessagesToChatSSE(values([{ type: "message_start", message: { id: "m", model: "m", usage: {} } }, { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tool", name: "f", input } }, { type: "content_block_stop", index: 0 }, { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: {} }, { type: "message_stop" }] as never[])))
  const result = await reassembleChatCompletions(values(output as unknown as ChatCompletionsStreamEvent[]))
  expect(JSON.parse(result.choices[0]?.message.tool_calls?.[0]?.function.arguments ?? "null")).toEqual(input)
})

test("owned Chat/Gemini state rejects replay under a user role", async () => {
  const chat = await stampAffinityItem("chat_completions", { role: "assistant", reasoning_text: "t", reasoning_opaque: "s" }, target, codec)
  await expect(analyzeAffinityRequest("chat_completions", { messages: [{ ...chat, role: "user" }] }, codec)).rejects.toBeInstanceOf(InvalidAffinityStateError)
  const gemini = await stampAffinityItem("gemini", { thought: true, text: "t", thoughtSignature: "s" }, target, codec)
  await expect(analyzeAffinityRequest("gemini", { contents: [{ role: "user", parts: [gemini] }] }, codec)).rejects.toBeInstanceOf(InvalidAffinityStateError)
})

import { TranslatorValidationError } from "../../../translate/src/errors.ts"

test("Chat mappings reject redacted or multiple independent opaque blocks instead of changing native state type", async () => {
  const base = { id: "r", type: "message" as const, role: "assistant" as const, model: "m", stop_reason: "end_turn" as const, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } }
  expect(() => translateMessagesToChatBody({ ...base, content: [{ type: "redacted_thinking", data: "opaque" }] })).toThrow(TranslatorValidationError)
  await expect(Array.fromAsync(translateMessagesToChatSSE(values([{ type: "content_block_start", index: 0, content_block: { type: "redacted_thinking", data: "opaque" } }] as never[])))).rejects.toBeInstanceOf(TranslatorValidationError)
  expect(() => translateMessagesToChatBody({ ...base, content: [{ type: "thinking", thinking: "a", signature: "a" }, { type: "thinking", thinking: "b", signature: "b" }] })).toThrow(TranslatorValidationError)
})

test("Chat reassembly joins split dialect companions using canonical precedence", async () => {
  const result = await reassembleChatCompletions(values([chunk(0, { reasoning_content: "a" }), chunk(0, { reasoning_text: "", reasoning_content: "ignore" }), chunk(0, { reasoning_content: "b" }, "stop")]))
  expect(result.choices[0]?.message.reasoning_text).toBe("ab")
})

test("Chat emits complete reasoning with its one carrier for native SDK object-assignment aggregation", async () => {
  const context = { protocol: "chat_completions" as const, codec, analysis: await analyzeAffinityRequest("chat_completions", {}, codec), actual: target }
  const output = await Array.fromAsync(new AffinityEgress(context).chat(values([eventFrame(chunk(0, { reasoning_content: "a", content: "live" })), eventFrame(chunk(0, { reasoning_content: "b", reasoning_opaque: "sig" }, "stop")), doneFrame()])))
  const deltas = output.flatMap(frame => frame.type === "event" ? frame.event.choices.map(choice => choice.delta) : [])
  expect(deltas[0]).toEqual({ content: "live" })
  expect(deltas[1]).toMatchObject({ reasoning_text: "ab" })
  const message = Object.assign({ role: "assistant" }, ...deltas)
  expect((await analyzeAffinityRequest("chat_completions", { messages: [message] }, codec)).materialize(target)).toEqual({ messages: [{ ...message, reasoning_opaque: "sig" }] })
})

test("Chat never emits DONE before rejecting unterminated opaque state", async () => {
  const context = { protocol: "chat_completions" as const, codec, analysis: await analyzeAffinityRequest("chat_completions", {}, codec), actual: target }
  const emitted: unknown[] = []
  await expect((async () => { for await (const frame of new AffinityEgress(context).chat(values([eventFrame(chunk(0, { reasoning_text: "a", reasoning_opaque: "sig" })), doneFrame()]))) emitted.push(frame.type) })()).rejects.toBeInstanceOf(InvalidAffinityStateError)
  expect(emitted).not.toContain("done")
})

import { AffinityRoutingUnavailableError } from "../../src/shared/affinity/analysis.ts"
import { chatCompletionsAttempt } from "../../src/data-plane/chat-flow/chat-completions/attempt.ts"
import { geminiAttempt } from "../../src/data-plane/chat-flow/gemini/attempt.ts"
import { translateResponsesToGeminiEvents } from "../../../translate/src/gemini-via-responses/events.ts"

test("Chat and Gemini selection errors become structured execution results with the original status", async () => {
  const selectBinding = async (): Promise<never> => { throw new AffinityRoutingUnavailableError() }
  const common = { auth: {}, ctx: {}, telemetryCtx: {} as never, selectBinding }
  for (const result of [await chatCompletionsAttempt.generate({ ...common, payload: { model: "m" } }), await geminiAttempt.generate({ ...common, payload: {}, model: "m", forceStream: false })]) {
    expect(result).toMatchObject({ type: "internal-error", status: 503, error: { code: "affinity_routing_unavailable" } })
  }
})

test("Chat/Gemini reject nonrepresentable Responses output state including terminal-only envelopes", async () => {
  for (const item of [{ type: "compaction", encrypted_content: "required" }, { type: "agent_message", content: [{ type: "encrypted_content", encrypted_content: "required" }] }]) {
    expect(() => translateResponsesToChatBody({ id: "r", output: [item] })).toThrow(TranslatorValidationError)
    const terminal = { type: "response.completed", response: { output: [item] } }
    await expect(Array.fromAsync(translateResponsesToGeminiEvents(values([terminal])))).rejects.toBeInstanceOf(TranslatorValidationError)
    for (const protocol of ["chat_completions", "gemini"] as const) {
      const context = { protocol, codec, analysis: await analyzeAffinityRequest(protocol, {}, codec), actual: target }
      await expect(Array.fromAsync(guardAffinityFrames(values([eventFrame(terminal)]), context))).rejects.toBeInstanceOf(TranslatorValidationError)
    }
  }
})

import { translateResponsesToChatSSE } from "../../../translate/src/chat-completions-via-responses/events.ts"
import { translateGeminiToChat } from "../../../translate/src/gemini-via-chat-completions/request.ts"
import { translateResponsesToGeminiBody } from "../../../translate/src/gemini-via-responses/body.ts"
import type { ResponsesProgramOutputItem } from "@vibe-llm/protocols/responses"

const programOutput: ResponsesProgramOutputItem = { type: "program_output", id: "po_1", call_id: "call_1", result: "42", status: "completed" }

test("Chat/Gemini JSON reject native program_output without opaque properties", async () => {
  const body = { id: "r", output: [programOutput] }
  expect(() => translateResponsesToChatBody(body)).toThrow(TranslatorValidationError)
  await expect(translateResponsesToGeminiBody(body, { model: "m" })).rejects.toBeInstanceOf(TranslatorValidationError)
})

for (const type of ["response.output_item.added", "response.output_item.done", "response.created", "response.in_progress", "response.completed", "response.incomplete", "response.failed"]) {
  test(`Chat/Gemini reject native program_output in ${type}`, async () => {
    const event = type.startsWith("response.output_item.") ? { type, output_index: 0, item: programOutput } : { type, response: { output: [programOutput] } }
    await expect(Array.fromAsync(translateResponsesToChatSSE(values([event])))).rejects.toBeInstanceOf(TranslatorValidationError)
    await expect(Array.fromAsync(translateResponsesToGeminiEvents(values([event])))).rejects.toBeInstanceOf(TranslatorValidationError)
    for (const protocol of ["chat_completions", "gemini"] as const) {
      const context = { protocol, codec, analysis: await analyzeAffinityRequest(protocol, {}, codec), actual: target }
      await expect(Array.fromAsync(guardAffinityFrames(values([eventFrame(event)]), context))).rejects.toBeInstanceOf(TranslatorValidationError)
    }
  })
}

test("Chat/Gemini preserve tool business JSON named program_output", async () => {
  const business = { type: "program_output", nested: programOutput }
  const item = { type: "function_call", id: "fc_1", call_id: "call_1", name: "f", arguments: JSON.stringify(business) }
  const body = { id: "r", output: [item] }
  const events = [{ type: "response.output_item.added", output_index: 0, item }, { type: "response.output_item.done", output_index: 0, item }, { type: "response.completed", response: body }]
  expect(JSON.parse(translateResponsesToChatBody(body).choices[0]?.message.tool_calls?.[0]?.function.arguments ?? "null")).toEqual(business)
  expect((await translateResponsesToGeminiBody(body, { model: "m" })).candidates?.[0]?.content?.parts?.[0]?.functionCall?.args).toEqual(business)
  const chat = await Array.fromAsync(translateResponsesToChatSSE(values(events)))
  expect(chat.flatMap(event => event.choices.flatMap(choice => choice.delta.tool_calls ?? []))).toContainEqual(expect.objectContaining({ function: expect.objectContaining({ arguments: JSON.stringify(business) }) }))
  const gemini = await Array.fromAsync(translateResponsesToGeminiEvents(values(events)))
  expect(gemini.flatMap(event => "candidates" in event ? event.candidates?.flatMap(candidate => candidate.content?.parts ?? []) ?? [] : [])).toContainEqual(expect.objectContaining({ functionCall: expect.objectContaining({ args: business }) }))
  for (const protocol of ["chat_completions", "gemini"] as const) {
    const context = { protocol, codec, analysis: await analyzeAffinityRequest(protocol, {}, codec), actual: target }
    const frames = events.map(eventFrame)
    expect(await Array.fromAsync(guardAffinityFrames(values(frames), context))).toEqual(frames)
  }
})

test("Responses terminal-only opaque reasoning is retained in both Chat and Gemini source events", async () => {
  const terminal = { type: "response.completed", response: { output: [{ type: "reasoning", summary: [{ text: " \n " }], encrypted_content: "opaque" }] } }
  const chat = await Array.fromAsync(translateResponsesToChatSSE(values([terminal])))
  expect(chat.flatMap(event => event.choices.map(choice => choice.delta))).toContainEqual({ reasoning_text: " \n ", reasoning_opaque: "opaque" })
  const gemini = await Array.fromAsync(translateResponsesToGeminiEvents(values([terminal])))
  expect(gemini.flatMap(event => "candidates" in event ? event.candidates?.flatMap(candidate => candidate.content?.parts ?? []) ?? [] : [])).toContainEqual({ text: " \n ", thought: true, thoughtSignature: "opaque" })
})

test("Gemini cannot flatten a signed thought alongside another thought into a different companion", () => {
  expect(() => translateGeminiToChat({ contents: [{ role: "model", parts: [{ thought: true, text: "a", thoughtSignature: "signature" }, { thought: true, text: "b" }] }] }, { model: "m" })).toThrow(TranslatorValidationError)
})

test("foreign Gemini signatures on non-thought Parts reject unrepresentable state without silently dropping it", () => {
  expect(() => translateGeminiToChat({ contents: [{ role: "model", parts: [{ functionCall: { id: "a", name: "f", args: {} }, thoughtSignature: "foreign" }] }] }, { model: "m" })).toThrow(TranslatorValidationError)
})

test("opaque Chat input cannot select a dialect interceptor that discards its signature", async () => {
  const message = await stampAffinityItem("chat_completions", { role: "assistant", content: "answer", reasoning_text: "thought", reasoning_opaque: "sig" }, target, codec)
  const source = { messages: [message] }
  const context = { protocol: "chat_completions" as const, codec, analysis: await analyzeAffinityRequest("chat_completions", source, codec) }
  const provider: LlmModelProvider = { name: "fixture", kind: "custom", supportedEndpoints: ["chat_completions"], getPricingForModelKey: () => null, getModels: async () => ({ object: "list", data: [] }), probe: async () => ({ ok: true }), fetch: async () => { throw new Error("must not infer") }, prepareAffinityExecution: async () => target }
  const binding: LlmProviderBinding = { kind: "custom", upstream: "up", enabledFlags: new Set(["reasoning-content-dialect"]), model: { id: "m", endpoints: { chat_completions: {} } }, provider }
  await expect(selectAffinityCandidate([{ binding, targetEndpoint: "chat_completions" }], context, "m")).rejects.toBeInstanceOf(AffinityRoutingUnavailableError)
})
