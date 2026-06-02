import { describe, expect, test } from "bun:test"

import { translateChatCompletionsToMessages } from "~/translators/chat-completions-via-messages/request"
import { translateMessagesToChatCompletions } from "~/translators/messages-via-chat-completions/request"
import { translateMessagesToResponses } from "~/translators/messages-via-responses/request"
import { translateResponsesToMessages } from "~/translators/responses-via-messages/request"
import { disableMessagesReasoningOnForcedToolChoice } from "~/transforms/disable-reasoning-on-forced-tool-choice"
import type { AnthropicMessagesPayload, ResponsesPayload } from "~/transforms/types"

const SAMPLE_SCHEMA = {
  type: "object",
  properties: { name: { type: "string" } },
  required: ["name"],
  additionalProperties: false,
}

describe("messages → responses: structured outputs", () => {
  test("forwards output_config.format as text.format with synthesized name + strict", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4-7",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 100,
      output_config: { effort: "high", format: { type: "json_schema", schema: SAMPLE_SCHEMA } },
    }
    const out = translateMessagesToResponses(payload)
    expect(out.text).toEqual({
      format: {
        type: "json_schema",
        name: "messages_response",
        strict: true,
        schema: SAMPLE_SCHEMA,
      },
    })
    expect(out.reasoning).toEqual({ effort: "high" })
  })

  test("no text when format absent", () => {
    const out = translateMessagesToResponses({
      model: "x",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 100,
      output_config: { effort: "low" },
    })
    expect(out.text).toBeUndefined()
  })
})

describe("messages → chat-completions: structured outputs", () => {
  test("forwards output_config.format as response_format.json_schema", () => {
    const out = translateMessagesToChatCompletions({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 100,
      output_config: { format: { type: "json_schema", schema: SAMPLE_SCHEMA } },
    })
    expect(out.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "messages_response", strict: true, schema: SAMPLE_SCHEMA },
    })
  })

  test("no response_format when format absent", () => {
    const out = translateMessagesToChatCompletions({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 100,
    })
    expect(out.response_format).toBeUndefined()
  })
})

describe("responses → messages: structured outputs", () => {
  test("extracts flat text.format into output_config.format", () => {
    const payload: ResponsesPayload = {
      model: "claude-opus-4-7",
      input: "hi",
      max_output_tokens: 100,
      reasoning: { effort: "high" },
      text: { format: { type: "json_schema", name: "x", schema: SAMPLE_SCHEMA } },
    }
    const { target } = translateResponsesToMessages(payload)
    expect(target.output_config).toEqual({
      effort: "high",
      format: { type: "json_schema", schema: SAMPLE_SCHEMA },
    })
  })

  test("absent text.format drops cleanly", () => {
    const { target } = translateResponsesToMessages({
      model: "claude-opus-4-7",
      input: "hi",
      max_output_tokens: 100,
    })
    expect(target.output_config).toBeUndefined()
  })

  test("schema-as-array is rejected (drops)", () => {
    const { target } = translateResponsesToMessages({
      model: "claude-opus-4-7",
      input: "hi",
      max_output_tokens: 100,
      text: { format: { type: "json_schema", schema: [] as unknown as Record<string, unknown> } },
    })
    expect(target.output_config).toBeUndefined()
  })
})

describe("chat-completions → messages: structured outputs", () => {
  test("extracts nested response_format.json_schema.schema", () => {
    const out = translateChatCompletionsToMessages({
      model: "claude-opus-4-7",
      messages: [{ role: "user", content: "hi" }],
      response_format: {
        type: "json_schema",
        json_schema: { name: "x", strict: true, schema: SAMPLE_SCHEMA },
      },
    })
    expect(out.output_config).toEqual({
      format: { type: "json_schema", schema: SAMPLE_SCHEMA },
    })
  })

  test("json_object drops (no Messages equivalent)", () => {
    const out = translateChatCompletionsToMessages({
      model: "claude-opus-4-7",
      messages: [{ role: "user", content: "hi" }],
      response_format: { type: "json_object" },
    })
    expect(out.output_config).toBeUndefined()
  })

  test("absent response_format drops", () => {
    const out = translateChatCompletionsToMessages({
      model: "claude-opus-4-7",
      messages: [{ role: "user", content: "hi" }],
    })
    expect(out.output_config).toBeUndefined()
  })
})

describe("disableMessagesReasoningOnForcedToolChoice preserves format", () => {
  test("strips effort only, preserves format", () => {
    const flags = new Set(["disable-reasoning-on-forced-tool-choice"])
    const payload = {
      model: "claude-opus-4-7",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 100,
      output_config: { effort: "high", format: { type: "json_schema", schema: SAMPLE_SCHEMA } },
      tool_choice: { type: "tool", name: "x" },
    } as unknown as AnthropicMessagesPayload
    disableMessagesReasoningOnForcedToolChoice(payload, flags)
    expect(payload.output_config).toEqual({
      format: { type: "json_schema", schema: SAMPLE_SCHEMA },
    })
    expect((payload as unknown as { thinking: unknown }).thinking).toEqual({ type: "disabled" })
  })

  test("output_config removed when only effort was present", () => {
    const flags = new Set(["disable-reasoning-on-forced-tool-choice"])
    const payload = {
      model: "claude-opus-4-7",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 100,
      output_config: { effort: "high" },
      tool_choice: { type: "any" },
    } as unknown as AnthropicMessagesPayload
    disableMessagesReasoningOnForcedToolChoice(payload, flags)
    expect(payload.output_config).toBeUndefined()
  })
})
