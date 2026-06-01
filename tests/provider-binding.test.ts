import { test, expect, describe } from "bun:test"
import type { ProviderBinding } from "~/providers/binding"
import { bindingServesEndpoint, bindingsForEndpoint } from "~/providers/binding"

const stubProvider = {
  kind: "copilot" as const,
  name: "stub",
  supportedEndpoints: ["chat_completions", "responses", "messages", "messages_count_tokens", "embeddings"] as const,
  getModels: () => Promise.resolve({ object: "list", data: [] }),
  probe: () => Promise.resolve({ ok: true }),
  fetch: () => Promise.resolve(new Response()),
  callMessages: () => Promise.resolve(new Response()),
  callMessagesCountTokens: () => Promise.resolve(new Response()),
  callEmbeddings: () => Promise.resolve(new Response()),
}

function makeBinding(
  upstream: string,
  endpoints: readonly ProviderBinding["upstreamEndpoints"][number][],
): ProviderBinding {
  return {
    upstream,
    kind: "copilot",
    model: { id: "stub-model" },
    upstreamEndpoints: endpoints,
    enabledFlags: new Set(),
    provider: stubProvider,
  }
}

describe("bindingServesEndpoint", () => {
  test("true when endpoint listed", () => {
    const b = makeBinding("u1", ["chat_completions", "responses"])
    expect(bindingServesEndpoint(b, "chat_completions")).toBe(true)
    expect(bindingServesEndpoint(b, "messages")).toBe(false)
  })
})

describe("bindingsForEndpoint", () => {
  test("filters to bindings that natively serve the endpoint", () => {
    const b1 = makeBinding("u1", ["chat_completions"])
    const b2 = makeBinding("u2", ["messages", "chat_completions"])
    const b3 = makeBinding("u3", ["responses"])
    const out = bindingsForEndpoint([b1, b2, b3], "chat_completions")
    expect(out.map((b) => b.upstream)).toEqual(["u1", "u2"])
  })
  test("returns empty when no binding serves the endpoint", () => {
    const b1 = makeBinding("u1", ["chat_completions"])
    expect(bindingsForEndpoint([b1], "embeddings")).toEqual([])
  })
})
