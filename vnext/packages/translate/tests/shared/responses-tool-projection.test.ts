import { describe, expect, test } from "bun:test"
import type { ResponsesPayload } from "@vibe-llm/protocols/responses"
import { TranslatorValidationError } from "../../src/errors.ts"
import { translateResponsesToChat } from "../../src/responses-via-chat-completions/request.ts"
import { translateResponsesToMessages } from "../../src/responses-via-messages/request.ts"

const declarations = [
  { type: "function", name: "first", parameters: { type: "object" } },
  { type: "function", name: "second", parameters: { type: "object" } },
  { type: "function", name: "third", parameters: { type: "object" } },
]

for (const [kind, translate] of [
  ["chat", translateResponsesToChat],
  ["messages", translateResponsesToMessages],
] as const) {
  const run = (fields: Record<string, unknown>) => translate({ model: "test", input: [], ...fields } as ResponsesPayload).target
  describe(`Responses tool projection to ${kind}`, () => {
    test.each(["auto", "required"])("preserves allowed subset order, mode %s and source", (mode) => {
      const source = {
        tools: declarations,
        tool_choice: { type: "allowed_tools", mode, tools: [{ type: "function", name: "third" }, { type: "function", name: "first" }] },
      }
      const before = structuredClone(source)
      const target = run(source)
      const names = (target.tools as Array<{ name?: string; function?: { name: string } }>).map(t => t.name ?? t.function?.name)
      expect(names).toEqual(["first", "third"])
      expect(target.tool_choice).toEqual(kind === "chat" ? mode : { type: mode === "required" ? "any" : "auto" })
      expect(source).toEqual(before)
    })

    test("empty automatic subset disables tools", () => {
      const target = run({ tools: declarations, tool_choice: { type: "allowed_tools", mode: "auto", tools: [] } })
      expect(target.tools).toBeUndefined()
      expect(target.tool_choice).toEqual(kind === "chat" ? "none" : { type: "none" })
    })

    test.each([
      { type: "allowed_tools", mode: "required", tools: [] },
      { type: "allowed_tools", mode: "none", tools: [] },
      { type: "allowed_tools", mode: "auto", tools: null },
      { type: "allowed_tools", mode: "auto", tools: [null] },
      { type: "allowed_tools", mode: "auto", tools: [{ type: "function", name: "missing" }] },
      { type: "allowed_tools", mode: "auto", tools: [{ type: "function", name: "first", namespace: "ns" }] },
      { type: "allowed_tools", mode: "auto", tools: [{ type: "web_search" }] },
      { type: "allowed_tools", mode: "auto", tools: [{ type: "function", name: "first", extension: true }] },
      { type: "function", name: "missing" },
      { type: "function", name: "first", namespace: "ns" },
      { type: "web_search" },
    ])("rejects unsupported or undeclared choice %j", tool_choice => {
      expect(() => run({ tools: declarations, tool_choice })).toThrow(TranslatorValidationError)
    })

    test("selecting the function kind avoids an excluded custom collision", () => {
      const target = run({
        tools: [{ type: "custom", name: "first" }, ...declarations],
        tool_choice: { type: "allowed_tools", mode: "required", tools: [{ type: "function", name: "first" }] },
      })
      expect(target.tools).toHaveLength(1)
    })

    test.each([undefined, { type: "allowed_tools", mode: "auto", tools: [{ type: "function", name: "first" }, { type: "custom", name: "first" }] }])("rejects ambiguous callable kinds", tool_choice => {
      expect(() => run({ tools: [{ type: "custom", name: "first" }, ...declarations], tool_choice })).toThrow(/callable kinds/)
    })

    test.each(["additional_tools", "tool_search_output"])("rejects ambiguous historical %s inventory", type => {
      expect(() => run({ input: [{ type, tools: [{ type: "function", name: "same" }, { type: "custom", name: "same" }] }] })).toThrow(/callable kinds/)
    })

    test("rejects an allowed flat selector backed only by a namespaced declaration", () => {
      expect(() => run({
        tools: [{ type: "function", name: "first", namespace: "ns" }],
        tool_choice: { type: "allowed_tools", mode: "auto", tools: [{ type: "function", name: "first" }] },
      })).toThrow(TranslatorValidationError)
    })

    test.each(["additional_tools", "tool_search_output"])("rejects unexpanded historical %s declarations", type => {
      expect(() => run({ input: [{ type, tools: declarations }] })).toThrow(/historical tool inventories/)
    })

    test("rejects namespace declarations and historical calls without identity mapping", () => {
      expect(() => run({ tools: [{ type: "function", name: "first", namespace: "ns" }] })).toThrow(TranslatorValidationError)
      expect(() => run({ input: [{ type: "function_call", name: "first", call_id: "c", namespace: "ns", arguments: "{}" }] })).toThrow(TranslatorValidationError)
    })

    test("projects flat custom declaration, choice and historical call through one string input", () => {
      const tools = [{ type: "custom", name: "script", format: { type: "text" } }]
      const target = run({ tools, tool_choice: { type: "custom", name: "script" }, input: [
        { type: "custom_tool_call", name: "old-script", call_id: "c", input: "echo hi" },
      ] })
      if (kind === "chat") {
        expect(target.tools).toMatchObject([{ type: "function", function: { name: "script", parameters: { required: ["input"], properties: { input: { type: "string" } } } } }])
        expect(target.tool_choice).toEqual({ type: "function", function: { name: "script" } })
        expect(target.messages).toMatchObject([{ role: "assistant", tool_calls: [{ id: "c", function: { name: "old-script", arguments: '{"input":"echo hi"}' } }] }])
      } else {
        expect(target.tools).toMatchObject([{ name: "script", input_schema: { required: ["input"], properties: { input: { type: "string" } } } }])
        expect(target.tool_choice).toEqual({ type: "tool", name: "script" })
        expect(target.messages).toMatchObject([{ role: "assistant", content: [{ type: "tool_use", id: "c", name: "old-script", input: { input: "echo hi" } }] }])
      }
      const selected = run({ tools: [{ type: "custom", name: "script" }, ...declarations], tool_choice: {
        type: "allowed_tools", mode: "auto", tools: [{ type: "custom", name: "script" }],
      } })
      expect(selected.tools).toHaveLength(1)
    })

    test("rejects constrained custom format and malformed or namespaced historical calls", () => {
      expect(() => run({ tools: [{ type: "custom", name: "script", format: { type: "grammar", syntax: "lark", definition: "start: /./" } }] })).toThrow(TranslatorValidationError)
      expect(() => run({ input: [{ type: "custom_tool_call", name: "script", call_id: "c", input: 12 }] })).toThrow(TranslatorValidationError)
      expect(() => run({ input: [{ type: "custom_tool_call", name: "script", call_id: "c", input: "x", namespace: "ns" }] })).toThrow(TranslatorValidationError)
    })

    test.each(["function_call_output", "custom_tool_call_output"])("preserves structured %s IDs, empty text and status semantics", type => {
      const target = run({ input: [
        { type, call_id: "a", output: [{ type: "input_text", text: "one" }, { type: "output_text", text: "two" }], status: "incomplete" },
        { type, call_id: "b", output: [] },
      ] })
      if (kind === "chat") {
        expect(target.messages).toEqual([
          { role: "tool", tool_call_id: "a", content: "onetwo" },
          { role: "tool", tool_call_id: "b", content: "" },
        ])
      } else {
        expect(target.messages).toEqual([{ role: "user", content: [
          { type: "tool_result", tool_use_id: "a", content: [{ type: "text", text: "one" }, { type: "text", text: "two" }], ...(type === "function_call_output" ? { is_error: true } : {}) },
          { type: "tool_result", tool_use_id: "b", content: "", cache_control: { type: "ephemeral" } },
        ] }])
      }
    })

    test.each(["function_call_output", "custom_tool_call_output"])("projects %s images into legal carriers after contiguous results", type => {
      const target = run({ input: [
        { type, call_id: "a", output: [{ type: "input_text", text: "one" }, { type: "input_image", image_url: "data:image/png;base64,AAAA" }] },
        { type, call_id: "b", output: [{ type: "input_image", image_url: "https://example.test/image.png", detail: "high" }] },
        { type: "message", role: "user", content: "continue" },
      ] })
      if (kind === "chat") {
        expect(target.messages).toEqual([
          { role: "tool", tool_call_id: "a", content: "one" },
          { role: "tool", tool_call_id: "b", content: "Image output is attached in the following user message." },
          { role: "user", content: [
            { type: "text", text: "Image output from tool call a:" },
            { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
            { type: "text", text: "Image output from tool call b:" },
            { type: "image_url", image_url: { url: "https://example.test/image.png", detail: "high" } },
          ] },
          { role: "user", content: "continue" },
        ])
      } else {
        expect(target.messages[0]).toEqual({ role: "user", content: [
          { type: "tool_result", tool_use_id: "a", content: [{ type: "text", text: "one" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }] },
          { type: "tool_result", tool_use_id: "b", content: [{ type: "image", source: { type: "url", url: "https://example.test/image.png" } }] },
        ] })
      }
    })

    test("flushes mixed tool-output images at end of history without mutating input", () => {
      const input = [
        { type: "function_call", name: "first", call_id: "a", arguments: "{}" },
        { type: "function_call", name: "second", call_id: "b", arguments: "{}" },
        { type: "function_call_output", call_id: "a", output: [{ type: "input_image", image_url: "https://example.test/a.png" }] },
        { type: "custom_tool_call_output", call_id: "b", output: "done", status: "incomplete" },
      ]
      const before = structuredClone(input)
      const target = run({ input })
      expect(input).toEqual(before)
      if (kind === "chat") {
        expect(target.messages.map(message => message.role)).toEqual(["assistant", "tool", "tool", "user"])
        expect(target.messages[2]).toEqual({ role: "tool", tool_call_id: "b", content: "done" })
        expect(target.messages[3]?.content).toEqual([
          { type: "text", text: "Image output from tool call a:" },
          { type: "image_url", image_url: { url: "https://example.test/a.png" } },
        ])
      } else {
        expect(target.messages).toHaveLength(2)
        expect(target.messages[1]?.content).toMatchObject([
          { type: "tool_result", tool_use_id: "a" },
          { type: "tool_result", tool_use_id: "b", content: "done" },
        ])
        const results = target.messages[1]?.content as Array<{ is_error?: boolean }>
        expect(results.map(result => result.is_error)).toEqual([undefined, undefined])
      }
    })

    test.each(["function_call_output", "custom_tool_call_output"])("rejects malformed %s output and missing call ID", type => {
      expect(() => run({ input: [{ type, output: "result" }] })).toThrow(TranslatorValidationError)
      expect(() => run({ input: [{ type, call_id: "a", output: { text: "result" } }] })).toThrow(TranslatorValidationError)
    })

    test.each([
      { type: "input_image", file_id: "file_1" },
      { type: "input_image", image_url: "" },
      { type: "input_image", image_url: "data:image/svg+xml;base64,AAAA" },
      { type: "input_image", image_url: "data:image/png,AAAA" },
      { type: "input_image", image_url: "file:///image.png" },
      { type: "input_file", file_id: "file_1" },
      { type: "refusal", refusal: "no" },
    ])("rejects unrepresentable output content %j", part => {
      for (const type of ["function_call_output", "custom_tool_call_output"]) {
        expect(() => run({ input: [{ type, call_id: "a", output: [part] }] })).toThrow(TranslatorValidationError)
      }
    })
  })
}
