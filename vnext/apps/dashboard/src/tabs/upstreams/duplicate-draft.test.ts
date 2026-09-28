import { expect, test } from "bun:test"
import type { UpstreamRecord } from "../../api/types"
import { createPortableUpstreamDraft, isFreshCredential } from "./duplicate-draft"

function source(provider: UpstreamRecord["provider"], config: Record<string, unknown>): UpstreamRecord {
  return {
    id: "source-id",
    ownerId: "owner-1",
    provider,
    name: "Original",
    enabled: false,
    sortOrder: 42,
    config: config as UpstreamRecord["config"],
    flagOverrides: { image_generation: false },
    disabledPublicModelIds: ["model-1"],
    proxyFallbackList: [{ id: "proxy-1", colos: ["SJC"] }],
    tokenExpiredAt: "2026-01-01T00:00:00Z",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  }
}

test("custom duplicate keeps portable model metadata and deep copies nested draft values", () => {
  const original = source("custom", {
    name: "Original",
    baseUrl: "https://example.test/v1",
    authStyle: "none",
    endpoints: ["responses"],
    pathOverrides: { responses: "/custom/responses" },
    modelsEndpoint: "https://example.test/models",
    models: [
      { id: "model-1", chat: { reasoning: { budget_tokens: { min: 16, max: 8192 } } }, apiKey: "hidden", "X-API-Key": "hidden", label: "***" },
      { upstreamModelId: "model-1", cost: { input: 0.1, input_cache_read: 0.05 } },
    ],
    apiKey: "***",
    token: "***",
    state: { quota: 3 },
  })
  const draft = createPortableUpstreamDraft(original, "Original (copy)")
  expect(draft).toEqual({
    provider: "custom",
    name: "Original (copy)",
    config: {
      baseUrl: "https://example.test/v1",
      authStyle: "none",
      endpoints: ["responses"],
      pathOverrides: { responses: "/custom/responses" },
      modelsEndpoint: "https://example.test/models",
      models: [
        { id: "model-1", chat: { reasoning: { budget_tokens: { min: 16, max: 8192 } } } },
        { upstreamModelId: "model-1", cost: { input: 0.1, input_cache_read: 0.05 } },
      ],
    },
    flagOverrides: { image_generation: false },
    disabledPublicModelIds: ["model-1"],
    proxyFallbackList: [{ id: "proxy-1", colos: ["SJC"] }],
  })
  const copiedModel = (draft.config.models as { chat?: { reasoning?: { budget_tokens?: { min: number } } } }[])[0]
  const copiedProxy = draft.proxyFallbackList[0]
  if (!copiedModel?.chat?.reasoning?.budget_tokens || !copiedProxy?.colos) throw new Error("Expected copied nested values")
  copiedModel.chat.reasoning.budget_tokens.min = 32
  copiedProxy.colos.push("LAX")
  draft.flagOverrides.image_generation = true
  expect((original.config.models as unknown as { chat: { reasoning: { budget_tokens: { min: number } } } }[])[0]?.chat.reasoning.budget_tokens.min).toBe(16)
  expect(original.proxyFallbackList?.[0]?.colos).toEqual(["SJC"])
  expect(original.flagOverrides?.image_generation).toBe(false)
})

test("Azure and SDF drafts keep portable settings but no credential, identity, or runtime state", () => {
  const azure = createPortableUpstreamDraft(source("azure", {
    endpoint: "https://azure.test",
    apiKey: "***",
    deployment: "gpt-4o",
    apiVersion: "2024-08-01-preview",
    endpoints: ["chat_completions"],
    deployments: [{ name: "alt", model: "gpt-4o" }],
    defaultHeaders: { Authorization: "***" },
  }), "Azure copy")
  expect(azure.config).toEqual({
    endpoint: "https://azure.test",
    deployment: "gpt-4o",
    apiVersion: "2024-08-01-preview",
    endpoints: ["chat_completions"],
    deployments: [{ name: "alt", model: "gpt-4o" }],
  })

  const sdf = createPortableUpstreamDraft(source("sdf", {
    substrateToken: "***",
    taxonomy: { experience: "BizChat", agent: "Assistant" },
    cos: { serviceTier: "priority" },
    passport: { enabled: false, apiBase: "https://passport.test" },
    accountId: "account-1",
  }), "SDF copy")
  expect(sdf.config).toEqual({
    taxonomy: { experience: "BizChat", agent: "Assistant" },
    cos: { serviceTier: "priority" },
    passport: { enabled: false, apiBase: "https://passport.test" },
  })
  expect(JSON.stringify([azure, sdf])).not.toMatch(/source-id|owner-1|account-1|substrateToken|apiKey|tokenExpiredAt|createdAt|sortOrder/)
})

test("Copilot OAuth cannot become a duplicate draft, and redaction markers are not credentials", () => {
  expect(() => createPortableUpstreamDraft(source("copilot", { githubToken: "***" }), "copy")).toThrow()
  expect(isFreshCredential("***")).toBe(false)
  expect(isFreshCredential("  ***  ")).toBe(false)
  expect(isFreshCredential("  ")).toBe(false)
  expect(isFreshCredential("new-credential")).toBe(true)
})

test("duplicate strips URL userinfo and credential query keys while keeping unrelated parameters", () => {
  const custom = createPortableUpstreamDraft(source("custom", {
    baseUrl: "https://user:pass@api.example.test/v1",
    authStyle: "none",
    modelsEndpoint: "https://u:p@example.test/models?region=us&api_key=hidden&page=2&X-Amz-Signature=signed",
    pathOverrides: { responses: "/responses?tenant=acme&access_token=hidden&mode=fast" },
  }), "Copy")
  expect(custom.config.baseUrl).toBe("https://api.example.test/v1")
  expect(custom.config.modelsEndpoint).toBe("https://example.test/models?region=us&page=2")
  expect(custom.config.pathOverrides).toEqual({ responses: "/responses?tenant=acme&mode=fast" })

  const azure = createPortableUpstreamDraft(source("azure", {
    endpoint: "https://u:p@azure.example.test?tenant=one&api-key=hidden",
  }), "Copy")
  expect(azure.config.endpoint).toBe("https://azure.example.test/?tenant=one")
  const sdf = createPortableUpstreamDraft(source("sdf", {
    passport: { apiBase: "https://u:p@passport.example.test?region=us&token=hidden", enabled: true },
  }), "Copy")
  expect(sdf.config.passport).toEqual({ apiBase: "https://passport.example.test/?region=us", enabled: true })
})

test("duplicate strips common secret and access-key aliases without dropping public query values", () => {
  const draft = createPortableUpstreamDraft(source("custom", {
    authStyle: "none",
    modelsEndpoint: "https://example.test/models?client_secret=s3&access_key=k1&secret_access_key=k2&client_id=public&monkey=banana&region=us",
    pathOverrides: { responses: "/responses?consumer-secret=s4&mode=fast" },
  }), "Copy")
  expect(draft.config.modelsEndpoint).toBe("https://example.test/models?client_id=public&monkey=banana&region=us")
  expect(draft.config.pathOverrides).toEqual({ responses: "/responses?mode=fast" })
})
