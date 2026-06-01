import { test, expect } from "bun:test"
import type { ModelProvider } from "~/providers/types"
import type { EndpointKey } from "~/protocols/common"

test("ModelProvider interface declares supportedEndpoints and fetch()", () => {
  // Compile-time only: a value satisfying the interface must have both.
  const stub: Pick<ModelProvider, "supportedEndpoints" | "fetch"> = {
    supportedEndpoints: ["chat_completions"] as readonly EndpointKey[],
    fetch: async () => new Response("ok"),
  }
  expect(stub.supportedEndpoints).toContain("chat_completions")
})

import { CopilotProvider } from "~/providers/copilot/provider"

test("CopilotProvider declares its supportedEndpoints", () => {
  const p = new CopilotProvider({ copilotToken: "tok", accountType: "individual" })
  expect([...p.supportedEndpoints].sort()).toEqual([
    "chat_completions",
    "embeddings",
    "messages",
    "messages_count_tokens",
    "responses",
  ])
})

test("CopilotProvider.fetch and callChatCompletions are both functions with correct shape", () => {
  const p = new CopilotProvider({ copilotToken: "tok", accountType: "individual" })
  expect(typeof p.fetch).toBe("function")
  expect(typeof p.callChatCompletions).toBe("function")
})
