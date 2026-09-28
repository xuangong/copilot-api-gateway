import { expect, test } from "bun:test"
import { codexTomlSnippet } from "./configSnippets"

test("generated Codex provider explicitly uses supported HTTP Responses transport", () => {
  const snippet = codexTomlSnippet("test-model", "https://gateway.example")
  const config = Bun.TOML.parse(snippet)
  expect(config).toMatchObject({
    model: "test-model",
    model_providers: { copilot_gateway: { wire_api: "responses", supports_websockets: false } },
  })
})
