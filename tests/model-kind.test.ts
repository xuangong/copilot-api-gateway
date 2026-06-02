import { describe, expect, test } from "bun:test"

import { bindingServesEndpoint, type ProviderBinding } from "~/providers/binding"
import { inferModelKind } from "~/providers/registry"
import type { Model } from "~/services/copilot/models"

function fakeModel(overrides: Partial<Model> & { id: string }): Model {
  return {
    id: overrides.id,
    name: overrides.name ?? overrides.id,
    object: "model",
    vendor: overrides.vendor ?? "test",
    version: overrides.version ?? "1",
    model_picker_enabled: true,
    preview: false,
    capabilities: overrides.capabilities ?? {
      family: "test",
      limits: {},
      object: "model_capabilities",
      supports: {},
      tokenizer: "unknown",
      type: "text",
    },
  }
}

function fakeBinding(kind: ProviderBinding["model"]["kind"], endpoints: ProviderBinding["upstreamEndpoints"]): ProviderBinding {
  return {
    upstream: "up_test",
    kind: "custom",
    model: { id: "x", kind },
    upstreamEndpoints: endpoints,
    enabledFlags: new Set<string>(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    provider: {} as any,
  }
}

describe("inferModelKind", () => {
  test("capabilities.type=embeddings → embedding", () => {
    const m = fakeModel({
      id: "text-embedding-3-small",
      capabilities: { family: "openai", limits: {}, object: "model_capabilities", supports: {}, tokenizer: "cl100k", type: "embeddings" },
    })
    expect(inferModelKind(m)).toBe("embedding")
  })

  test("capabilities.type=image → image", () => {
    const m = fakeModel({
      id: "some-image",
      capabilities: { family: "openai", limits: {}, object: "model_capabilities", supports: {}, tokenizer: "n/a", type: "image" },
    })
    expect(inferModelKind(m)).toBe("image")
  })

  test("id prefix gpt-image / dall-e → image", () => {
    expect(inferModelKind(fakeModel({ id: "gpt-image-2" }))).toBe("image")
    expect(inferModelKind(fakeModel({ id: "dall-e-3" }))).toBe("image")
  })

  test("unknown chat model returns undefined (defer to upstream)", () => {
    expect(inferModelKind(fakeModel({ id: "claude-opus-4-7" }))).toBeUndefined()
    expect(inferModelKind(fakeModel({ id: "embed-custom" }))).toBeUndefined()
  })
})

describe("bindingServesEndpoint kind compatibility", () => {
  test("embedding model rejects chat_completions even if upstream lists it", () => {
    const b = fakeBinding("embedding", ["chat_completions", "embeddings"])
    expect(bindingServesEndpoint(b, "chat_completions")).toBe(false)
    expect(bindingServesEndpoint(b, "embeddings")).toBe(true)
  })

  test("image model rejects chat/embeddings, accepts images_*", () => {
    const b = fakeBinding("image", ["chat_completions", "embeddings", "images_generations", "images_edits"])
    expect(bindingServesEndpoint(b, "chat_completions")).toBe(false)
    expect(bindingServesEndpoint(b, "embeddings")).toBe(false)
    expect(bindingServesEndpoint(b, "images_generations")).toBe(true)
    expect(bindingServesEndpoint(b, "images_edits")).toBe(true)
  })

  test("chat model rejects embeddings and images", () => {
    const b = fakeBinding("chat", ["chat_completions", "responses", "messages", "messages_count_tokens", "embeddings", "images_generations"])
    expect(bindingServesEndpoint(b, "chat_completions")).toBe(true)
    expect(bindingServesEndpoint(b, "messages")).toBe(true)
    expect(bindingServesEndpoint(b, "embeddings")).toBe(false)
    expect(bindingServesEndpoint(b, "images_generations")).toBe(false)
  })

  test("undefined kind defers to upstream endpoints", () => {
    const b = fakeBinding(undefined, ["embeddings"])
    expect(bindingServesEndpoint(b, "embeddings")).toBe(true)
    expect(bindingServesEndpoint(b, "chat_completions")).toBe(false)
  })
})
