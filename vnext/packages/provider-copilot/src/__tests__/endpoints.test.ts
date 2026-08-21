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

test("GPT-5 mini only advertises responses + messages_count_tokens (chat_completions suppressed)", () => {
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
  expect(result.messages_count_tokens).toBeDefined()
  expect(result.chat_completions).toBeUndefined()
  expect(result.messages).toBeUndefined()
})

test("o1-preview only advertises responses + messages_count_tokens", () => {
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
  expect(result.messages_count_tokens).toBeDefined()
  expect(result.chat_completions).toBeUndefined()
  expect(result.messages).toBeUndefined()
})

test("o3-mini only advertises responses + messages_count_tokens", () => {
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
  expect(result.messages_count_tokens).toBeDefined()
  expect(result.chat_completions).toBeUndefined()
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

// ─── supported_endpoints (live catalog) ──────────────────────────────
//
// Copilot's `/models` DOES carry `supported_endpoints` for its newer entries
// (grok, mai-code, gemini-3.x, gpt-5.x, claude-*), and omits it for the legacy
// tail (gpt-4o and older). When present it is authoritative: inferring by id
// prefix routed `grok-4.6` / `mai-code-1-flash-picker` to /chat/completions,
// which Copilot answers with `unsupported_api_for_model`.

test("grok-4.6 follows supported_endpoints to responses only", () => {
  const model = createModel({
    id: "grok-4.6",
    capabilities: {
      type: "chat",
      family: "grok-4.6",
      object: "model.capability",
      limits: {},
      supports: {},
      tokenizer: "",
    },
    supported_endpoints: ["/responses"],
  })

  const result = copilotModelEndpoints(model)

  expect(result.responses).toBeDefined()
  expect(result.chat_completions).toBeUndefined()
  expect(result.messages).toBeUndefined()
  expect(result.messages_count_tokens).toBeDefined()
})

test("mai-code-1-flash-picker follows supported_endpoints to responses only", () => {
  const model = createModel({
    id: "mai-code-1-flash-picker",
    capabilities: {
      type: "chat",
      family: "mai-code-1-flash-picker",
      object: "model.capability",
      limits: {},
      supports: {},
      tokenizer: "",
    },
    supported_endpoints: ["/responses"],
  })

  const result = copilotModelEndpoints(model)

  expect(result.responses).toBeDefined()
  expect(result.chat_completions).toBeUndefined()
})

test("gemini-3.6-flash follows supported_endpoints to chat_completions only", () => {
  const model = createModel({
    id: "gemini-3.6-flash",
    capabilities: {
      type: "chat",
      family: "gemini-3.6-flash",
      object: "model.capability",
      limits: {},
      supports: {},
      tokenizer: "",
    },
    supported_endpoints: ["/chat/completions"],
  })

  const result = copilotModelEndpoints(model)

  expect(result.chat_completions).toBeDefined()
  expect(result.responses).toBeUndefined()
})

test("claude reads messages + chat_completions straight off supported_endpoints", () => {
  const model = createModel({
    id: "claude-opus-5",
    capabilities: {
      type: "chat",
      family: "claude-opus-5",
      object: "model.capability",
      limits: {},
      supports: {},
      tokenizer: "",
    },
    supported_endpoints: ["/v1/messages", "/chat/completions"],
  })

  const result = copilotModelEndpoints(model)

  expect(result.messages).toBeDefined()
  expect(result.chat_completions).toBeDefined()
  expect(result.responses).toBeUndefined()
})

// The websocket transport is a different dial, not a different protocol; the
// gateway has no `ws:/responses` endpoint kind, so the prefix is ignored.
test("ws: transport variants are ignored", () => {
  const model = createModel({
    id: "gpt-5.5",
    capabilities: {
      type: "chat",
      family: "gpt-5.5",
      object: "model.capability",
      limits: {},
      supports: {},
      tokenizer: "",
    },
    supported_endpoints: ["/responses", "ws:/responses"],
  })

  const result = copilotModelEndpoints(model)

  expect(result.responses).toBeDefined()
  expect(result.chat_completions).toBeUndefined()
})

// gpt-5.4 advertises /chat/completions, but Copilot rejects the legacy
// `max_tokens` there ("Use 'max_completion_tokens' instead"). The pre-existing
// suppression stays, so the catalog can only ever narrow this family.
test("gpt-5.4 keeps chat_completions suppressed even though the catalog lists it", () => {
  const model = createModel({
    id: "gpt-5.4",
    capabilities: {
      type: "chat",
      family: "gpt-5.4",
      object: "model.capability",
      limits: {},
      supports: {},
      tokenizer: "",
    },
    supported_endpoints: ["/responses", "/chat/completions", "ws:/responses"],
  })

  const result = copilotModelEndpoints(model)

  expect(result.responses).toBeDefined()
  expect(result.chat_completions).toBeUndefined()
})

// The legacy tail carries no `supported_endpoints`; the per-family inference
// remains the only signal there.
test("a model with no supported_endpoints still falls back to inference", () => {
  const model = createModel({
    id: "gpt-4o-2024-11-20",
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
  expect(result.responses).toBeUndefined()
})

// ─── family fallback for Responses-only vendors ──────────────────────
//
// xAI and MAI are Responses-only on Copilot. Today's catalog says so, but a
// tenant whose catalog omits `supported_endpoints` would otherwise fall into
// the chat_completions default and hit `unsupported_api_for_model` again. The
// inference is a safety net only — a catalog that does list the model still
// wins, unlike the gpt-5 suppression.

test("grok falls back to responses when the catalog is silent", () => {
  const model = createModel({
    id: "grok-5",
    capabilities: {
      type: "chat",
      family: "grok-5",
      object: "model.capability",
      limits: {},
      supports: {},
      tokenizer: "",
    },
  })

  const result = copilotModelEndpoints(model)

  expect(result.responses).toBeDefined()
  expect(result.chat_completions).toBeUndefined()
})

test("mai-code falls back to responses when the catalog is silent", () => {
  const model = createModel({
    id: "mai-code-2-flash",
    capabilities: {
      type: "chat",
      family: "mai-code-2-flash",
      object: "model.capability",
      limits: {},
      supports: {},
      tokenizer: "",
    },
  })

  const result = copilotModelEndpoints(model)

  expect(result.responses).toBeDefined()
  expect(result.chat_completions).toBeUndefined()
})

// Unlike gpt-5, there is no parameter incompatibility to work around here, so
// if Copilot ever serves an xAI model on /chat/completions the catalog governs.
test("a grok model whose catalog lists chat_completions keeps it", () => {
  const model = createModel({
    id: "grok-9",
    capabilities: {
      type: "chat",
      family: "grok-9",
      object: "model.capability",
      limits: {},
      supports: {},
      tokenizer: "",
    },
    supported_endpoints: ["/chat/completions"],
  })

  const result = copilotModelEndpoints(model)

  expect(result.chat_completions).toBeDefined()
  expect(result.responses).toBeUndefined()
})

// `mai-code` is the Responses-only family; an unrelated `mai-*` id must not be
// swept in by a loose prefix.
test("a non-mai-code MAI model is untouched by the fallback", () => {
  const model = createModel({
    id: "mai-chat-1",
    capabilities: {
      type: "chat",
      family: "mai-chat-1",
      object: "model.capability",
      limits: {},
      supports: {},
      tokenizer: "",
    },
  })

  const result = copilotModelEndpoints(model)

  expect(result.chat_completions).toBeDefined()
  expect(result.responses).toBeUndefined()
})
