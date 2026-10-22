import { expect, test } from "bun:test"
import { lokiRequestShape } from "../diagnostics"

test("rejected-request diagnostics retain compatibility fields without caller text or credentials", () => {
  const privateText = "private-user-content-and-secret"
  const shape = lokiRequestShape({ model: "claude-opus-5.5", temperature: 0, max_tokens: 1024,
    thinking: { type: "adaptive", block_binding: privateText }, tool_choice: { type: "tool", name: privateText },
    tools: [{ name: privateText, input_schema: { description: privateText } }],
    messages: [{ role: "user", content: [{ type: "text", text: privateText }] }],
    metadata: { user_id: privateText }, output_config: { effort: "low" }, [privateText]: privateText })
  expect(shape).toMatchObject({ model: "claude-opus-5.5", temperature: 0, thinking: "adaptive",
    thinkingBlockBinding: true, toolChoice: "tool", toolTypes: ["client"], contentTypes: ["text"], effort: "low" })
  expect(JSON.stringify(shape)).not.toContain(privateText)
  const arbitrary = lokiRequestShape({ model: privateText, thinking: { type: privateText },
    tool_choice: { type: privateText }, tools: [{ type: privateText }],
    messages: [{ content: [{ type: privateText }] }], output_config: { effort: privateText }, temperature: privateText })
  expect(JSON.stringify(arbitrary)).not.toContain(privateText)
})
