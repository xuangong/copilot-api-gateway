import { test, expect } from "bun:test"
import { copilotModelEndpoints } from "../endpoints"
import type { Model } from "../models"

// Helper to create minimal valid Model fixtures
function createModel(overrides: Partial<Model>): Model {
  return {
    id: "test-model",
    capabilities: {
      type: "chat",
      family: "",
      object: "model.capability",
      limits: {},
      supports: {},
      tokenizer: "",
    },
    model_picker_enabled: false,
    name: "Test Model",
    object: "model",
    preview: false,
    vendor: "test",
    version: "1.0",
    ...overrides,
  }
}

test("embeddings model returns only embeddings endpoint", () => {
  const model = createModel({
    id: "text-embedding-3-large",
    capabilities: {
      type: "embeddings",
      family: "",
      object: "model.capability",
      limits: {},
      supports: {},
      tokenizer: "",
    },
  })

  const result = copilotModelEndpoints(model)

  expect(result.embeddings).toBeDefined()
  expect(result.messages).toBeUndefined()
  expect(result.messages_count_tokens).toBeUndefined()
  expect(result.responses).toBeUndefined()
  expect(result.chat_completions).toBeUndefined()
})

test("Claude model has messages, messages_count_tokens, and chat_completions", () => {
  const model = createModel({
    id: "claude-3-5-sonnet-20241022",
    capabilities: {
      type: "chat",
      family: "claude-3.5-sonnet",
      object: "model.capability",
      limits: {},
      supports: {},
      tokenizer: "",
    },
  })

  const result = copilotModelEndpoints(model)

  expect(result.messages).toBeDefined()
  expect(result.messages_count_tokens).toBeDefined()
  expect(result.chat_completions).toBeDefined()
  expect(result.responses).toBeUndefined()
})

test("GPT-5 mini has responses, chat_completions, messages_count_tokens", () => {
  const model = createModel({
    id: "gpt-5-mini",
    capabilities: {
      type: "chat",
      family: "gpt-5",
      object: "model.capability",
      limits: {},
      supports: {},
      tokenizer: "",
    },
  })

  const result = copilotModelEndpoints(model)

  expect(result.responses).toBeDefined()
  expect(result.chat_completions).toBeDefined()
  expect(result.messages_count_tokens).toBeDefined()
  expect(result.messages).toBeUndefined()
})

test("o1-preview has responses, chat_completions, messages_count_tokens", () => {
  const model = createModel({
    id: "o1-preview",
    capabilities: {
      type: "chat",
      family: "o1",
      object: "model.capability",
      limits: {},
      supports: {},
      tokenizer: "",
    },
  })

  const result = copilotModelEndpoints(model)

  expect(result.responses).toBeDefined()
  expect(result.chat_completions).toBeDefined()
  expect(result.messages_count_tokens).toBeDefined()
  expect(result.messages).toBeUndefined()
})

test("o3-mini has responses, chat_completions, messages_count_tokens", () => {
  const model = createModel({
    id: "o3-mini",
    capabilities: {
      type: "chat",
      family: "o3",
      object: "model.capability",
      limits: {},
      supports: {},
      tokenizer: "",
    },
  })

  const result = copilotModelEndpoints(model)

  expect(result.responses).toBeDefined()
  expect(result.chat_completions).toBeDefined()
  expect(result.messages_count_tokens).toBeDefined()
  expect(result.messages).toBeUndefined()
})

test("o2-mini has chat_completions + messages_count_tokens (o2 not matched by regex)", () => {
  const model = createModel({
    id: "o2-mini",
    capabilities: {
      type: "chat",
      family: "o2",
      object: "model.capability",
      limits: {},
      supports: {},
      tokenizer: "",
    },
  })

  const result = copilotModelEndpoints(model)

  expect(result.chat_completions).toBeDefined()
  expect(result.messages_count_tokens).toBeDefined()
  expect(result.responses).toBeUndefined()
  expect(result.messages).toBeUndefined()
})

test("gpt-4o has chat_completions + messages_count_tokens", () => {
  const model = createModel({
    id: "gpt-4o",
    capabilities: {
      type: "chat",
      family: "gpt-4o",
      object: "model.capability",
      limits: {},
      supports: {},
      tokenizer: "",
    },
  })

  const result = copilotModelEndpoints(model)

  expect(result.chat_completions).toBeDefined()
  expect(result.messages_count_tokens).toBeDefined()
  expect(result.responses).toBeUndefined()
  expect(result.messages).toBeUndefined()
})

test("gemini-1.5-pro has chat_completions + messages_count_tokens", () => {
  const model = createModel({
    id: "gemini-1.5-pro",
    capabilities: {
      type: "chat",
      family: "gemini-1.5-pro",
      object: "model.capability",
      limits: {},
      supports: {},
      tokenizer: "",
    },
  })

  const result = copilotModelEndpoints(model)

  expect(result.chat_completions).toBeDefined()
  expect(result.messages_count_tokens).toBeDefined()
  expect(result.responses).toBeUndefined()
  expect(result.messages).toBeUndefined()
})
