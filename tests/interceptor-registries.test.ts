import { describe, expect, test } from "bun:test"
import { messagesPayloadInterceptors } from "~/providers/copilot/interceptors/messages"
import { responsesPayloadInterceptors } from "~/providers/copilot/interceptors/responses"
import { chatCompletionsPayloadInterceptors } from "~/providers/copilot/interceptors/chat-completions"
import { embeddingsPayloadInterceptors } from "~/providers/copilot/interceptors/embeddings"

describe("Copilot interceptor registries", () => {
  test("messages registry has 6 entries in canonical order", () => {
    expect(messagesPayloadInterceptors).toHaveLength(6)
    expect(messagesPayloadInterceptors[0]!.name).toBe("withClaudeAgentHeaders")
    expect(messagesPayloadInterceptors[5]!.name).toBe("withInlineImagesCompressed")
  })
  test("responses registry has 5 entries", () => {
    expect(responsesPayloadInterceptors).toHaveLength(5)
  })
  test("chat_completions registry has 3 entries", () => {
    expect(chatCompletionsPayloadInterceptors).toHaveLength(3)
  })
  test("embeddings registry is empty (only variant filtering applies)", () => {
    expect(embeddingsPayloadInterceptors).toHaveLength(0)
  })
})
