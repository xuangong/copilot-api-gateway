import { describe, expect, test } from "bun:test"
import { classifyOutputEvent } from "../src/common/performance-metrics"

describe("meaningful output classification", () => {
  test("ignores starts, heartbeat, usage, empty deltas and citations", () => {
    for (const protocol of ["messages", "responses", "chat_completions", "gemini"] as const) {
      for (const event of [null, {}, { type: "ping" }, { type: "response.created" }, { type: "message_start" }, { choices: [{ delta: { role: "assistant", content: "" } }] }, { usage: { output_tokens: 50 } }, { type: "response.output_text.annotation.added", annotation: "citation" }]) {
        expect(classifyOutputEvent(protocol, event)).toEqual({ output: false, text: false })
      }
    }
  })
  test("separates answer text from reasoning and tool arguments in every protocol", () => {
    const cases = [
      ["messages", { type: "content_block_delta", delta: { type: "text_delta", text: "a" } }, true],
      ["messages", { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "r" } }, false],
      ["messages", { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "{}" } }, false],
      ["responses", { type: "response.output_text.delta", delta: "a" }, true],
      ["responses", { type: "response.reasoning_summary_text.delta", delta: "r" }, false],
      ["responses", { type: "response.function_call_arguments.delta", delta: "{}" }, false],
      ["chat_completions", { choices: [{ delta: { content: "a" } }] }, true],
      ["chat_completions", { choices: [{ delta: { reasoning_content: "r" } }] }, false],
      ["chat_completions", { choices: [{ delta: { reasoning_text: "r" } }] }, false],
      ["chat_completions", { choices: [{ delta: { tool_calls: [{ function: { arguments: "{}" } }] } }] }, false],
      ["gemini", { candidates: [{ content: { parts: [{ text: "a" }] } }] }, true],
      ["gemini", { candidates: [{ content: { parts: [{ text: "r", thought: true }] } }] }, false],
      ["gemini", { candidates: [{ content: { parts: [{ functionCall: { name: "f", args: {} } }] } }] }, false],
    ] as const
    for (const [protocol, event, text] of cases) expect(classifyOutputEvent(protocol, event)).toEqual({ output: true, text })
  })
})

test("Messages nonempty initial block payload counts but empty tool setup does not", () => {
  expect(classifyOutputEvent("messages", { type: "content_block_start", content_block: { type: "text", text: "initial" } })).toEqual({ output: true, text: true })
  expect(classifyOutputEvent("messages", { type: "content_block_start", content_block: { type: "thinking", thinking: "initial" } })).toEqual({ output: true, text: false })
  expect(classifyOutputEvent("messages", { type: "content_block_start", content_block: { type: "tool_use", input: { query: "x" } } })).toEqual({ output: true, text: false })
  expect(classifyOutputEvent("messages", { type: "content_block_start", content_block: { type: "tool_use", input: {} } })).toEqual({ output: false, text: false })
})
