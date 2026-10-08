import { describe, expect, test } from "bun:test"
import { decodeWire, generationEvents, verifySuccess, verifyFailure, verifyCancellation, verifyReplay } from "./correctness-contracts"

const chat = (events: unknown[]) => events.map(event => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`).join("")
const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({ id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })
const usage = { prompt_tokens: 31, completion_tokens: 7, total_tokens: 38 }
const chatEvents = [chunk({ role: "assistant", content: "Weather ready." }), chunk({ tool_calls: [{ index: 0, id: "call_fixture", type: "function", function: { name: "weather", arguments: '{"city":' } }] }), chunk({ tool_calls: [{ index: 0, function: { arguments: '"Oslo"}' } }] }), chunk({}, "tool_calls"), { choices: [], usage }, "[DONE]"]
const input = (raw: string, protocol: "chat" | "responses" | "messages" = "chat", stream = true) => ({ status: 200, raw, protocol, stream, contentType: stream ? "text/event-stream" : "application/json" })

describe("independent client wire oracle", () => {
  test("accepts split arguments and rejects a lost argument fragment", () => {
    expect(verifySuccess(input(chat(chatEvents)), "tool").errors).toEqual([])
    expect(verifySuccess(input(chat(chatEvents.filter((_event, index) => index !== 2))), "tool").errors).toContain("tool arguments differ")
  })
  test("requires exact usage, one finish, and a unique last DONE", () => {
    expect(verifySuccess(input(chat(chatEvents.filter((_event, index) => index !== 4))), "tool").errors).toContain("usage differs")
    expect(verifySuccess(input(chat([...chatEvents.slice(0, -1), chunk({}, "tool_calls"), "[DONE]"])), "tool").errors).toContain("success terminal count differs")
    expect(verifySuccess(input(chat([...chatEvents, "[DONE]"])), "tool").errors).toContain("DONE must occur once and last")
    expect(verifySuccess(input(chat(["[DONE]", ...chatEvents.slice(0, -1)])), "tool").errors).toContain("DONE must occur once and last")
  })
  test("rejects missing Chat role and duplicated usage witnesses", () => {
    expect(verifySuccess(input(chat([chunk({ content: "Weather ready." }), ...chatEvents.slice(1)])), "tool").errors).toContain("missing assistant role")
    expect(verifySuccess(input(chat([...chatEvents.slice(0, -1), { choices: [], usage }, "[DONE]"])), "tool").errors).toContain("usage count differs")
  })
  test("rejects Responses or Messages terminal before semantic output", () => {
    for (const protocol of ["responses", "messages"] as const) {
      const events = generationEvents(protocol, "text", "fixture")
      expect(verifySuccess(input(chat(events), protocol), "text").errors).toEqual([])
      expect(verifySuccess(input(chat([events.at(-1), ...events.slice(0, -1)]), protocol), "text").errors).toContain("success terminal must be the final event")
      expect(verifySuccess(input(chat([...events, "[DONE]"]), protocol), "text").errors).toEqual([])
    }
  })
  test("accepts generic JSON-fallback item witnesses without inventing upstream deltas", () => {
    const message = { id: "m", type: "message", role: "assistant", content: [{ type: "output_text", text: "Weather ready." }] }
    const tool = { id: "fc", type: "function_call", call_id: "call_fixture", name: "weather", arguments: '{"city":"Oslo"}' }
    const response = { status: "completed", output: [message, tool], usage: { input_tokens: 31, output_tokens: 7, total_tokens: 38 } }
    const raw = chat([...[message, tool].flatMap(item => [{ type: "response.output_item.added", item }, { type: "response.output_item.done", item }]), { type: "response.completed", response }])
    expect(verifySuccess(input(raw, "responses"), "tool", { synthesizedFromJson: true }).errors).toEqual([])
    expect(verifySuccess(input(raw, "responses"), "tool").errors).toContain("text delta differs")
    expect(verifySuccess(input(raw.replace("Oslo", "Rome"), "responses"), "tool", { synthesizedFromJson: true }).errors).toContain("generic item witnesses differ")
  })
  test("rejects a Messages delta after its block is closed", () => {
    const events = generationEvents("messages", "text", "fixture")
    const stop = events.findIndex(event => typeof event === "object" && event.type === "content_block_stop")
    const bad = [...events.slice(0, stop), events[stop], { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "" } }, ...events.slice(stop + 1)]
    expect(verifySuccess(input(chat(bad), "messages"), "text").errors).toContain("invalid Messages block lifecycle")
  })
  test("uses Responses deltas and final output as independent witnesses", () => {
    const response = { id: "r", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Weather ready." }] }], usage: { input_tokens: 31, output_tokens: 7, total_tokens: 38 } }
    const events = [{ type: "response.output_text.delta", delta: "Weather ready." }, { type: "response.completed", response }]
    expect(verifySuccess(input(chat(events), "responses"), "text").errors).toEqual([])
    expect(verifySuccess(input(chat([{ type: "response.output_text.delta", delta: "Weather " }, events[1]]), "responses"), "text").errors).toContain("text delta differs")
  })
  test("preserves Messages tool identity and input/output usage", () => {
    const raw = JSON.stringify({ type: "message", role: "assistant", content: [{ type: "text", text: "Weather ready." }, { type: "tool_use", id: "call_fixture", name: "weather", input: { city: "Oslo" } }], stop_reason: "tool_use", usage: { input_tokens: 31, output_tokens: 7 } })
    expect(verifySuccess(input(raw, "messages", false), "tool").errors).toEqual([])
    expect(verifySuccess(input(raw.replace("call_fixture", "wrong"), "messages", false), "tool").errors).toContain("tool identity differs")
  })
  test("rejects wrong response format and malformed SSE JSON", () => {
    expect(verifySuccess({ ...input("{}"), contentType: "application/json" }, "text").errors).toContain("downstream content type differs")
    expect(() => decodeWire("data: {bad}\n\n", true)).toThrow()
  })
  test("does not accept HTTP errors, failed events, or truncated streams as success", () => {
    const failed = input(chat([{ type: "response.failed", response: { status: "failed", error: { message: "fixture" } } }]), "responses")
    expect(verifyFailure(failed).errors).toEqual([])
    expect(verifyFailure(input(chat(chatEvents))).errors).toContain("failure emitted success terminal")
    expect(verifyFailure({ ...input('{"error":{"message":"fixture"}}', "responses", false), status: 502 }).errors).toEqual([])
    expect(verifyFailure(input('{"object":"response","status":"failed","error":{"message":"fixture"}}', "responses", false)).errors).toEqual([])
    expect(verifySuccess(input(chat(chatEvents.slice(0, 3))), "tool").errors).toContain("success terminal count differs")
    expect(verifyFailure(input(chat(chatEvents.slice(0, 3)))).errors).toContain("failure has no error evidence")
  })
  test("requires an observed upstream close before cleanup releases a cancelled stream", () => {
    expect(verifyCancellation({ semanticSeen: true, clientCancelled: true, upstreamClosed: true, normalCompletionSent: false, gateReleased: false }).errors).toEqual([])
    expect(verifyCancellation({ semanticSeen: true, clientCancelled: true, upstreamClosed: false, normalCompletionSent: false, gateReleased: false }).errors).toContain("upstream did not close before cleanup")
    expect(verifyCancellation({ semanticSeen: true, clientCancelled: true, upstreamClosed: true, normalCompletionSent: false, gateReleased: true }).errors).toContain("completion gate was released")
  })
  test("checks native opaque replay and physical source identity without decoding the product carrier", () => {
    const body = { model: "canary-responses-opaque", input: [{ type: "compaction", encrypted_content: "required-native-state" }, { type: "reasoning", encrypted_content: "native-signature", summary: [{ type: "summary_text", text: "  complete thought\n" }] }] }
    expect(verifyReplay(body, "source-a", "source-a").errors).toEqual([])
    expect(verifyReplay(body, "source-b", "source-a").errors).toContain("opaque replay reached another source")
    expect(verifyReplay({ ...body, input: [{ type: "compaction", encrypted_content: "wrapped" }] }, "source-a", "source-a").errors).toContain("required opaque was not restored exactly")
  })
  test("accepts a native synthetic prefix while requiring the natural reasoning carrier exactly once", () => {
    const output = [{ id: "prefix", type: "reasoning", summary: [], encrypted_content: "native-synthetic-wrapper" }, { id: "m", type: "message", role: "assistant", content: [{ type: "output_text", text: "Weather ready." }] }, { id: "reasoning", type: "reasoning", summary: [{ type: "summary_text", text: "  complete thought\n" }], encrypted_content: "wrapped-native-reasoning" }, { id: "compaction", type: "compaction", encrypted_content: "wrapped-required-state" }]
    const response = { status: "completed", output, usage: { input_tokens: 31, output_tokens: 7, total_tokens: 38 } }
    const raw = chat([{ type: "response.output_text.delta", delta: "Weather ready." }, ...output.map(item => ({ type: "response.output_item.done", item })), { type: "response.completed", response }])
    expect(verifySuccess(input(raw, "responses"), "opaque").errors).toEqual([])
  })
})
