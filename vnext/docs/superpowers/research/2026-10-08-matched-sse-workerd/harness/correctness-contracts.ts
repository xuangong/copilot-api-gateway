export type Protocol = "chat" | "responses" | "messages"
export type Obj = Record<string, unknown>
export type SuccessKind = "text" | "tool" | "opaque"
export interface WireInput { status: number; raw: string; protocol: Protocol; stream: boolean; contentType: string | null }
export interface Verdict { ok: boolean; errors: string[] }
export const TEXT = "Weather ready."
export const ARGUMENTS = '{"city":"Oslo"}'
export const THOUGHT = "  complete thought\n"
export const OPAQUE = "native-signature"
export const REQUIRED_OPAQUE = "required-native-state"
export const protocols: Protocol[] = ["chat", "responses", "messages"]
export const pathFor = (protocol: Protocol) => protocol === "chat" ? "/v1/chat/completions" : `/v1/${protocol}`
export const object = (value: unknown): Obj => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Obj : {}
export const items = (value: unknown): Obj[] => Array.isArray(value) ? value.map(object) : []
const result = (errors: string[]): Verdict => ({ ok: errors.length === 0, errors })
const textOf = (value: unknown) => typeof value === "string" ? value : ""

export function decodeWire(raw: string, stream: boolean): { events: Obj[]; donePositions: number[]; frameCount: number } {
  if (!stream) return { events: [object(JSON.parse(raw))], donePositions: [], frameCount: 1 }
  const events: Obj[] = [], donePositions: number[] = []
  let frameCount = 0
  for (const frame of raw.replaceAll("\r\n", "\n").split("\n\n")) {
    const data = frame.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n")
    if (!data) continue
    frameCount++
    if (data === "[DONE]") donePositions.push(frameCount - 1)
    else events.push(object(JSON.parse(data)))
  }
  return { events, donePositions, frameCount }
}

function terminalCount(protocol: Protocol, events: Obj[], stream: boolean): number {
  if (!stream) return events.filter(event => protocol === "responses" ? event.status === "completed" : protocol === "messages" ? typeof event.stop_reason === "string" : items(event.choices).some(choice => typeof choice.finish_reason === "string")).length
  return events.filter(event => protocol === "responses" ? event.type === "response.completed" : protocol === "messages" ? event.type === "message_stop" : items(event.choices).some(choice => typeof choice.finish_reason === "string")).length
}

export function finalResponses(input: WireInput): Obj {
  const { events } = decodeWire(input.raw, input.stream)
  return input.stream ? object(events.find(event => event.type === "response.completed")?.response) : events[0] ?? {}
}

export function verifySuccess(input: WireInput, kind: SuccessKind, options: { synthesizedFromJson?: boolean } = {}): Verdict {
  const errors: string[] = []
  if (input.status !== 200) errors.push("success HTTP status differs")
  if (!(input.contentType ?? "").includes(input.stream ? "text/event-stream" : "application/json")) errors.push("downstream content type differs")
  let decoded: ReturnType<typeof decodeWire>
  try { decoded = decodeWire(input.raw, input.stream) } catch { return result([...errors, "invalid response JSON"] ) }
  const { events, donePositions, frameCount } = decoded
  if (terminalCount(input.protocol, events, input.stream) !== 1) errors.push("success terminal count differs")
  if (input.stream && input.protocol !== "chat") {
    const terminal = input.protocol === "responses" ? "response.completed" : "message_stop"
    if (events.at(-1)?.type !== terminal || donePositions.length > 1 || (donePositions.length === 1 && donePositions[0] !== frameCount - 1)) errors.push("success terminal must be the final event")
  }
  if (events.some(event => event.error !== undefined && event.error !== null || ["error", "response.failed", "response.incomplete"].includes(String(event.type)))) errors.push("success contains failure")
  let text = "", deltaText = "", usage: Obj = {}, tools: Obj[] = [], reason: unknown
  if (input.protocol === "chat") {
    if (input.stream) {
      if (donePositions.length !== 1 || donePositions[0] !== frameCount - 1) errors.push("DONE must occur once and last")
      const byIndex = new Map<unknown, Obj>()
      let roleSeen = false, finished = false, usages = 0
      for (const event of events) {
        const choices = items(event.choices)
        if (!Array.isArray(event.choices) || choices.length > 1 || (!choices.length && (!event.usage || !finished))) errors.push("invalid Chat choice envelope")
        if (choices.length && finished) errors.push("choice after terminal")
        for (const choice of items(event.choices)) {
          const delta = object(choice.delta)
          if (choice.index !== 0) errors.push("choice index differs")
          if (delta.role === "assistant") roleSeen = true
          else if (delta.role !== undefined) errors.push("assistant role differs")
          text += textOf(delta.content)
          if (choice.finish_reason != null) { reason = choice.finish_reason; finished = true }
          for (const call of items(delta.tool_calls)) {
            const fn = object(call.function), previous = byIndex.get(call.index) ?? { id: "", name: "", arguments: "" }
            if (call.id !== undefined) previous.id = textOf(previous.id) + textOf(call.id)
            previous.name = textOf(previous.name) + textOf(fn.name)
            previous.arguments = textOf(previous.arguments) + textOf(fn.arguments)
            byIndex.set(call.index, previous)
          }
        }
        if (event.usage) { usage = object(event.usage); usages++; if (!finished) errors.push("usage before terminal") }
      }
      if (!roleSeen) errors.push("missing assistant role")
      if (usages !== 1) errors.push("usage count differs")
      tools = [...byIndex.values()]
    } else {
      const body = events[0] ?? {}, choices = items(body.choices), choice = choices[0] ?? {}, message = object(choice.message)
      if (choices.length !== 1 || message.role !== "assistant") errors.push("assistant choice differs")
      text = textOf(message.content); usage = object(body.usage); reason = choice.finish_reason
      tools = items(message.tool_calls).map(call => ({ id: call.id, ...object(call.function) }))
    }
    if (reason !== (kind === "tool" ? "tool_calls" : "stop")) errors.push("finish reason differs")
  } else if (input.protocol === "responses") {
    const body = input.stream ? object(events.find(event => event.type === "response.completed")?.response) : events[0] ?? {}
    const output = items(body.output)
    if (body.status !== "completed") errors.push("Responses final status differs")
    if (output.filter(item => item.type === "message").some(item => item.role !== "assistant")) errors.push("assistant role differs")
    text = output.filter(item => item.type === "message").flatMap(item => items(item.content)).filter(part => part.type === "output_text").map(part => textOf(part.text)).join("")
    usage = object(body.usage)
    tools = output.filter(item => item.type === "function_call").map(item => ({ id: item.call_id, name: item.name, arguments: item.arguments }))
    if (input.stream) {
      deltaText = events.filter(event => event.type === "response.output_text.delta").map(event => textOf(event.delta)).join("")
      const genericText = options.synthesizedFromJson && !events.some(event => event.type === "response.output_text.delta")
      if (!genericText && deltaText !== TEXT) errors.push("text delta differs")
      const genericArguments = options.synthesizedFromJson && !events.some(event => event.type === "response.function_call_arguments.delta")
      if (genericText || (kind === "tool" && genericArguments)) {
        for (const item of output.filter(item => item.type === "message" || item.type === "function_call")) {
          for (const type of ["response.output_item.added", "response.output_item.done"]) {
            const witnesses = events.filter(event => event.type === type && object(event.item).id === item.id)
            if (witnesses.length !== 1 || JSON.stringify(witnesses[0]?.item) !== JSON.stringify(item)) errors.push("generic item witnesses differ")
          }
        }
      }
      if (kind === "tool") {
        const starts = events.filter(event => event.type === "response.output_item.added" && object(event.item).type === "function_call")
        if (starts.length !== 1 || object(starts[0]?.item).call_id !== "call_fixture") errors.push("tool start differs")
        if (!genericArguments && events.filter(event => event.type === "response.function_call_arguments.delta").map(event => textOf(event.delta)).join("") !== ARGUMENTS) errors.push("tool arguments differ")
      }
    }
    if (kind === "opaque") {
      for (const type of ["reasoning", "compaction"]) {
        const entries = output.filter(item => item.type === type && (type !== "reasoning" || items(item.summary).map(part => textOf(part.text)).join("") === THOUGHT))
        if (entries.length !== 1 || typeof entries[0]?.encrypted_content !== "string" || !entries[0].encrypted_content || [OPAQUE, REQUIRED_OPAQUE].includes(entries[0].encrypted_content)) errors.push(`${type} carrier missing`)
        if (input.stream) {
          const done = events.filter(event => event.type === "response.output_item.done" && object(event.item).type === type && object(event.item).id === entries[0]?.id)
          if (done.length !== 1 || object(done[0]?.item).encrypted_content !== entries[0]?.encrypted_content) errors.push(`${type} carrier changed between terminal witnesses`)
        }
      }
    }
  } else {
    if (input.stream) {
      const blocks = new Map<unknown, Obj>()
      const closed = new Set<unknown>()
      let starts = 0, usageDeltas = 0
      for (const event of events) {
        if (event.type === "message_start") { starts++; usage = { ...object(object(event.message).usage) }; if (object(event.message).role !== "assistant") errors.push("assistant role differs") }
        if (event.type === "message_delta") { usageDeltas++; usage = { ...usage, ...object(event.usage) }; reason = object(event.delta).stop_reason }
        if (event.type === "content_block_start") {
          if (starts !== 1 || usageDeltas || blocks.has(event.index) || typeof event.index !== "number" || !Number.isSafeInteger(event.index) || event.index < 0) errors.push("invalid Messages block lifecycle")
          const block = object(event.content_block)
          blocks.set(event.index, { ...block, arguments: "" })
          if (block.type === "text") text += textOf(block.text)
        }
        if (event.type === "content_block_delta") {
          if (!blocks.has(event.index) || closed.has(event.index) || usageDeltas) errors.push("invalid Messages block lifecycle")
          const delta = object(event.delta)
          if (delta.type === "text_delta") text += textOf(delta.text)
          if (delta.type === "input_json_delta") {
            const block = blocks.get(event.index)
            if (block) block.arguments = textOf(block.arguments) + textOf(delta.partial_json)
          }
        }
        if (event.type === "content_block_stop") { if (!blocks.has(event.index) || closed.has(event.index)) errors.push("invalid Messages block lifecycle"); closed.add(event.index) }
      }
      if (starts !== 1 || usageDeltas !== 1 || events[0]?.type !== "message_start") errors.push("Messages lifecycle count differs")
      if (closed.size !== blocks.size) errors.push("invalid Messages block lifecycle")
      tools = [...blocks.values()].filter(block => block.type === "tool_use")
    } else {
      const body = events[0] ?? {}
      if (body.role !== "assistant") errors.push("assistant role differs")
      text = items(body.content).filter(item => item.type === "text").map(item => textOf(item.text)).join("")
      tools = items(body.content).filter(item => item.type === "tool_use").map(item => ({ ...item, arguments: JSON.stringify(item.input) }))
      usage = object(body.usage); reason = body.stop_reason
    }
    if (reason !== (kind === "tool" ? "tool_use" : "end_turn")) errors.push("finish reason differs")
  }
  if (text !== TEXT) errors.push("text differs")
  const incoming = input.protocol === "chat" ? usage.prompt_tokens : usage.input_tokens
  const outgoing = input.protocol === "chat" ? usage.completion_tokens : usage.output_tokens
  if (incoming !== 31 || outgoing !== 7 || (input.protocol !== "messages" && usage.total_tokens !== 38)) errors.push("usage differs")
  if (kind === "tool") {
    if (tools.length !== 1 || tools[0]?.id !== "call_fixture" || tools[0]?.name !== "weather") errors.push("tool identity differs")
    if (tools[0]?.arguments !== ARGUMENTS) errors.push("tool arguments differ")
  } else if (tools.length) errors.push("unexpected tool call")
  return result([...new Set(errors)])
}

export function verifyFailure(input: WireInput): Verdict {
  const errors: string[] = []
  let events: Obj[] = []
  try { events = decodeWire(input.raw, (input.contentType ?? "").includes("text/event-stream")).events } catch { errors.push("failure has invalid wire JSON") }
  const sse = (input.contentType ?? "").includes("text/event-stream")
  if (terminalCount(input.protocol, events, sse)) errors.push("failure emitted success terminal")
  const hasError = events.some(event => !!event.error || ["error", "response.failed", "response.incomplete"].includes(String(event.type)))
  if (!hasError) errors.push("failure has no error evidence")
  const nativeFailedResult = input.protocol === "responses" && events.length === 1 && events[0]?.object === "response" && events[0]?.status === "failed" && !!events[0]?.error
  if (!sse && input.status < 400 && !nativeFailedResult) errors.push("non-streaming failure returned success HTTP status")
  return result(errors)
}

export function verifyCancellation(input: { semanticSeen: boolean; clientCancelled: boolean; upstreamClosed: boolean; normalCompletionSent: boolean; gateReleased: boolean }): Verdict {
  const errors: string[] = []
  if (!input.semanticSeen || !input.clientCancelled) errors.push("client did not cancel after semantic output")
  if (!input.upstreamClosed) errors.push("upstream did not close before cleanup")
  if (input.normalCompletionSent) errors.push("upstream completed normally")
  if (input.gateReleased) errors.push("completion gate was released")
  return result(errors)
}

export function verifyReplay(body: Obj, actualSource: string, expectedSource: string): Verdict {
  const errors: string[] = [], input = items(body.input)
  if (actualSource !== expectedSource) errors.push("opaque replay reached another source")
  if (input.find(item => item.type === "compaction")?.encrypted_content !== REQUIRED_OPAQUE) errors.push("required opaque was not restored exactly")
  const reasoning = input.find(item => item.type === "reasoning")
  if (reasoning?.encrypted_content !== OPAQUE || items(reasoning.summary).map(item => textOf(item.text)).join("") !== THOUGHT) errors.push("reasoning was not restored exactly")
  if (JSON.stringify(body).includes("vnext-affinity:")) errors.push("gateway carrier leaked upstream")
  return result(errors)
}

// Adapted from gateway/tests/integration/generation-upstream-sse.sqlite.test.ts.
// The oracle above uses literal expectations and no product parser/aggregator.
export function terminal(protocol: Protocol, kind: SuccessKind, model: string): Obj {
  const call = { id: "fc_fixture", type: "function_call", call_id: "call_fixture", name: "weather", arguments: ARGUMENTS, status: "completed" }
  const message = { id: "msg_fixture", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: TEXT, annotations: [] }] }
  if (protocol === "chat") return { id: "chat_fixture", object: "chat.completion", created: 1, model, choices: [{ index: 0, message: { role: "assistant", content: TEXT, ...(kind === "tool" ? { tool_calls: [{ id: "call_fixture", type: "function", function: { name: "weather", arguments: ARGUMENTS } }] } : {}) }, finish_reason: kind === "tool" ? "tool_calls" : "stop" }], usage: { prompt_tokens: 31, completion_tokens: 7, total_tokens: 38 } }
  if (protocol === "responses") return { id: "resp_fixture", object: "response", model, status: "completed", output: [message, ...(kind === "tool" ? [call] : []), ...(kind === "opaque" ? [{ id: "reasoning", type: "reasoning", summary: [{ type: "summary_text", text: THOUGHT }], encrypted_content: OPAQUE }, { id: "compaction", type: "compaction", encrypted_content: REQUIRED_OPAQUE }] : [])], usage: { input_tokens: 31, output_tokens: 7, total_tokens: 38 } }
  return { id: "msg_fixture", type: "message", role: "assistant", model, content: [{ type: "text", text: TEXT }, ...(kind === "tool" ? [{ type: "tool_use", id: "call_fixture", name: "weather", input: { city: "Oslo" } }] : [])], stop_reason: kind === "tool" ? "tool_use" : "end_turn", stop_sequence: null, usage: { input_tokens: 31, output_tokens: 7 } }
}

export function generationEvents(protocol: Protocol, kind: SuccessKind, model: string): Array<Obj | string> {
  const final = terminal(protocol, kind, model)
  if (protocol === "chat") {
    const base = { id: "chat_fixture", object: "chat.completion.chunk", model, created: 1 }
    const chunk = (delta: Obj, finish_reason: string | null = null): Obj => ({ ...base, choices: [{ index: 0, delta, finish_reason }] })
    return [chunk({ role: "assistant", content: "Weather " }), chunk({ content: "ready." }), ...(kind === "tool" ? [chunk({ tool_calls: [{ index: 0, id: "call_fixture", type: "function", function: { name: "weather", arguments: '{"city":' } }] }), chunk({ tool_calls: [{ index: 0, function: { arguments: '"Oslo"}' } }] })] : []), chunk({}, kind === "tool" ? "tool_calls" : "stop"), { ...base, choices: [], usage: final.usage }, "[DONE]"]
  }
  if (protocol === "responses") {
    const output = items(final.output), message = output[0]
    const events: Array<Obj | string> = [{ type: "response.created", response: { ...final, status: "in_progress", output: [] } }, { type: "response.output_item.added", output_index: 0, item: { ...message, content: [], status: "in_progress" } }, { type: "response.content_part.added", output_index: 0, content_index: 0, item_id: "msg_fixture", part: { type: "output_text", text: "", annotations: [] } }, { type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: "msg_fixture", delta: "Weather " }, { type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: "msg_fixture", delta: "ready." }, { type: "response.output_text.done", output_index: 0, content_index: 0, item_id: "msg_fixture", text: TEXT }, { type: "response.output_item.done", output_index: 0, item: message }]
    for (const [offset, item] of output.slice(1).entries()) {
      const output_index = offset + 1
      events.push({ type: "response.output_item.added", output_index, item: item.type === "function_call" ? { ...item, arguments: "", status: "in_progress" } : { ...item, encrypted_content: "" } })
      if (item.type === "function_call") for (const delta of ['{"city":', '"Oslo"}']) events.push({ type: "response.function_call_arguments.delta", output_index, item_id: item.id, delta })
      if (item.type === "function_call") events.push({ type: "response.function_call_arguments.done", output_index, item_id: item.id, arguments: ARGUMENTS })
      events.push({ type: "response.output_item.done", output_index, item })
    }
    events.push({ type: "response.completed", response: final })
    return events
  }
  return [{ type: "message_start", message: { ...final, content: [], stop_reason: null, usage: { input_tokens: 31, output_tokens: 0 } } }, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Weather " } }, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ready." } }, { type: "content_block_stop", index: 0 }, ...(kind === "tool" ? [{ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "call_fixture", name: "weather", input: {} } }, { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"city":' } }, { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"Oslo"}' } }, { type: "content_block_stop", index: 1 }] : []), { type: "message_delta", delta: { stop_reason: final.stop_reason, stop_sequence: null }, usage: { output_tokens: 7 } }, { type: "message_stop" }]
}

export const frame = (event: Obj | string) => `${typeof event === "object" && typeof event.type === "string" ? `event: ${event.type}\n` : ""}data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`

export function makeInput(protocol: Protocol, model: string, stream: boolean, id: string, kind: SuccessKind = "text"): Obj {
  const common = { model, stream }, prompt = `CANARY_ID:${id} Find Oslo weather`
  const parameters = { type: "object", properties: { city: { type: "string" } } }
  if (protocol === "responses") return { ...common, input: [{ role: "user", content: prompt }], ...(kind === "tool" ? { tools: [{ type: "function", name: "weather", parameters }] } : {}) }
  const messages = [{ role: "user", content: prompt }]
  if (protocol === "messages") return { ...common, messages, max_tokens: 100, ...(kind === "tool" ? { tools: [{ name: "weather", input_schema: parameters }] } : {}) }
  return { ...common, messages, stream_options: { include_usage: true }, ...(kind === "tool" ? { tools: [{ type: "function", function: { name: "weather", parameters } }] } : {}) }
}
