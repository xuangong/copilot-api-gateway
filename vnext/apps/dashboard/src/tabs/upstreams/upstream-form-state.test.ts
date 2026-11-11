import { describe, expect, test } from "bun:test"
import type { UpstreamRecord } from "../../api/types"
import {
  AZURE_SERVED_ENDPOINTS,
  EMPTY,
  SDF_DEFAULTS,
  buildCreateConfig,
  buildEditConfig,
  buildInitial,
  groupFlags,
  parseAzureDeployments,
  sdfTuning,
} from "./upstream-form-state"

// Characterization tests: they pin the behaviour the form had before it was
// split into sections, so later restyling cannot quietly change it.

function row(provider: UpstreamRecord["provider"], config: Record<string, unknown>, extra: Partial<UpstreamRecord> = {}): UpstreamRecord {
  return {
    id: "up-1",
    provider,
    name: "Row",
    enabled: true,
    sortOrder: 0,
    config: config as UpstreamRecord["config"],
    disabledPublicModelIds: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...extra,
  }
}

describe("buildInitial", () => {
  test("create without a preset uses the provider's default endpoints", () => {
    expect(buildInitial({ kind: "create", provider: "custom" })).toEqual({
      provider: "custom",
      form: { ...EMPTY, endpoints: ["chat_completions", "embeddings"] },
    })
    expect(buildInitial({ kind: "create", provider: "azure" }).form.endpoints).toEqual(["chat_completions"])
    expect(buildInitial({ kind: "create", provider: "sdf" }).form.endpoints).toEqual(["images_generations", "images_edits"])
    expect(buildInitial({ kind: "create", provider: "codex" }).form.endpoints).toEqual(["chat_completions", "embeddings"])
  })

  test("a preset seeds a custom form with copies of its values", () => {
    const { provider, form } = buildInitial({ kind: "create", provider: "custom", presetId: "deepseek" })
    expect(provider).toBe("custom")
    expect(form.name).toBe("DeepSeek")
    expect(form.baseUrl).toBe("https://api.deepseek.com")
    expect(form.endpoints).toEqual(["chat_completions", "messages"])
    expect(form.pathOverrides).toEqual({
      chat_completions: "/v1/chat/completions",
      messages: "/anthropic/v1/messages",
    })
    expect(form.modelsEndpoint).toBe("https://api.deepseek.com/v1/models")
    expect(form.flagOverrides).toEqual({ "vendor-deepseek": true, "reasoning-content-dialect": true })
    expect(form.apiKey).toBe("")
    // Mutating the form must not reach back into the preset table.
    form.endpoints.push("responses")
    expect(buildInitial({ kind: "create", provider: "custom", presetId: "deepseek" }).form.endpoints)
      .toEqual(["chat_completions", "messages"])
  })

  test("a preset is ignored for non-custom providers", () => {
    expect(buildInitial({ kind: "create", provider: "azure", presetId: "deepseek" }).form.name).toBe("")
  })

  test("edit reads a custom row and never pre-fills its secret", () => {
    const { provider, form } = buildInitial({
      kind: "edit",
      row: row("custom", {
        baseUrl: "https://x.test/v1",
        apiKey: "***",
        endpoints: ["responses"],
        authStyle: "anthropic",
        pathOverrides: { responses: "/r" },
        modelsEndpoint: "https://x.test/models",
        models: ["a", "b"],
      }, { flagOverrides: { f: true } }),
    })
    expect(provider).toBe("custom")
    expect(form).toEqual({
      ...EMPTY,
      name: "Row",
      baseUrl: "https://x.test/v1",
      endpoints: ["responses"],
      authStyle: "anthropic",
      pathOverrides: { responses: "/r" },
      modelsEndpoint: "https://x.test/models",
      modelsText: "a\nb",
      flagOverrides: { f: true },
    })
  })

  test("edit reads azure deployments, sdf tuning and the copilot login", () => {
    const azure = buildInitial({
      kind: "edit",
      row: row("azure", {
        endpoint: "https://a.test",
        deployment: "gpt-4o",
        deployments: [{ name: "d1", model: "m1" }, { name: "d2" }],
      }),
    }).form
    expect(azure.endpoint).toBe("https://a.test")
    expect(azure.deployment).toBe("gpt-4o")
    expect(azure.apiVersion).toBe("2024-08-01-preview")
    expect(azure.endpoints).toEqual(["chat_completions"])
    expect(azure.azureDeployments).toBe("d1 = m1\nd2")
    expect(azure.baseUrl).toBe("")

    const sdf = buildInitial({
      kind: "edit",
      row: row("sdf", { taxonomy: { experience: "Scout" }, cos: { serviceTier: "flex" }, passport: { enabled: false } }),
    }).form
    expect(sdf.endpoints).toEqual(["images_generations", "images_edits"])
    expect(sdf.sdfExperience).toBe("Scout")
    expect(sdf.sdfAgent).toBe(SDF_DEFAULTS.agent)
    expect(sdf.sdfServiceTier).toBe("flex")
    expect(sdf.sdfPassportEnabled).toBe(false)
    expect(sdf.sdfPassportApiBase).toBe(SDF_DEFAULTS.passportApiBase)

    const copilot = buildInitial({
      kind: "edit",
      row: row("copilot", { user: { id: 1, login: "octo" } }),
    })
    expect(copilot.provider).toBe("copilot")
    expect(copilot.form.copilotLogin).toBe("octo")
  })

  test("duplicate reads the draft's provider and config", () => {
    const { provider, form } = buildInitial({
      kind: "create",
      provider: "custom",
      draft: {
        provider: "azure",
        name: "Copy",
        config: { endpoint: "https://a.test", deployment: "d", apiVersion: "2025-01-01" },
        flagOverrides: { g: false },
        disabledPublicModelIds: ["m"],
        proxyFallbackList: [],
      },
    })
    expect(provider).toBe("azure")
    expect(form.name).toBe("Copy")
    expect(form.endpoint).toBe("https://a.test")
    expect(form.apiVersion).toBe("2025-01-01")
    expect(form.azureApiKey).toBe("")
    expect(form.flagOverrides).toEqual({ g: false })
  })
})

describe("sdfTuning", () => {
  test("blank free-text fields fall back to the provider defaults", () => {
    expect(sdfTuning({ ...EMPTY, sdfAgent: "  ", sdfInferenceStep: "", sdfPassportApiBase: " " })).toEqual({
      taxonomy: {
        experience: SDF_DEFAULTS.experience,
        agent: SDF_DEFAULTS.agent,
        inferenceStep: SDF_DEFAULTS.inferenceStep,
        trafficType: SDF_DEFAULTS.trafficType,
      },
      cos: { serviceTier: SDF_DEFAULTS.serviceTier },
      passport: { enabled: true, apiBase: SDF_DEFAULTS.passportApiBase },
    })
  })

  test("filled fields are trimmed and sent as-is", () => {
    const tuning = sdfTuning({ ...EMPTY, sdfAgent: " Bot ", sdfTrafficType: "Test", sdfPassportEnabled: false })
    expect(tuning.taxonomy.agent).toBe("Bot")
    expect(tuning.taxonomy.trafficType).toBe("Test")
    expect(tuning.passport.enabled).toBe(false)
  })
})

describe("parseAzureDeployments", () => {
  test("blank text means no deployments", () => {
    expect(parseAzureDeployments("")).toBeUndefined()
    expect(parseAzureDeployments(" \n ")).toBeUndefined()
  })

  test("parses name = model lines and skips blank lines", () => {
    expect(parseAzureDeployments("a = m1\r\n\n  b=m2  ")).toEqual([
      { name: "a", model: "m1" },
      { name: "b", model: "m2" },
    ])
  })

  test("keeps duplicates in order", () => {
    expect(parseAzureDeployments("a = m\na = m")).toEqual([
      { name: "a", model: "m" },
      { name: "a", model: "m" },
    ])
  })

  test("lines the validator would reject still parse rather than throw", () => {
    expect(parseAzureDeployments("solo")).toEqual([{ name: "solo", model: "solo" }])
    expect(parseAzureDeployments("= m\nn =")).toEqual([
      { name: "", model: "m" },
      { name: "n", model: "" },
    ])
  })
})

describe("groupFlags", () => {
  const flag = (id: string) => ({ id, label: id, description: "" })

  test("groups by prefix in vendor, behavior, transform order and keeps catalog order", () => {
    const groups = groupFlags([
      flag("transform-a"),
      flag("x"),
      flag("vendor-b"),
      flag("vendor-a"),
      flag("y"),
    ])
    expect(groups.map((g) => [g.key, g.labelKey, g.flags.map((f) => f.id)])).toEqual([
      ["vendor", "dash.flagGroupVendor", ["vendor-b", "vendor-a"]],
      ["behavior", "dash.flagGroupBehavior", ["x", "y"]],
      ["transform", "dash.flagGroupTransform", ["transform-a"]],
    ])
  })

  test("omits empty groups", () => {
    expect(groupFlags([flag("x")]).map((g) => g.key)).toEqual(["behavior"])
    expect(groupFlags([])).toEqual([])
  })
})

describe("request bodies", () => {
  test("create custom requires a base URL and a fresh key unless auth is none", () => {
    expect(buildCreateConfig("custom", { ...EMPTY, name: "n" })).toEqual({ errorKey: "dash.errBaseUrlApiKeyRequired" })
    expect(buildCreateConfig("custom", { ...EMPTY, name: "n", baseUrl: "u", apiKey: "***" }))
      .toEqual({ errorKey: "dash.errBaseUrlApiKeyRequired" })
    expect(buildCreateConfig("custom", { ...EMPTY, name: " n ", baseUrl: " u ", authStyle: "none", modelsText: "a # A" })).toEqual({
      config: {
        name: "n",
        baseUrl: "u",
        endpoints: ["chat_completions", "embeddings"],
        authStyle: "none",
        pathOverrides: {},
        models: [{ id: "a", name: "A" }],
      },
    })
  })

  test("create sdf and azure validate their credentials", () => {
    expect(buildCreateConfig("sdf", { ...EMPTY, name: "n" })).toEqual({ errorKey: "dash.errSubstrateTokenRequired" })
    expect(buildCreateConfig("azure", { ...EMPTY, name: "n" })).toEqual({ errorKey: "dash.errEndpointApiKeyDeploymentRequired" })
    expect(buildCreateConfig("azure", {
      ...EMPTY,
      name: "n",
      endpoint: "e",
      azureApiKey: "k",
      deployment: "d",
      apiVersion: " ",
      endpoints: ["chat_completions"],
      azureDeployments: "a = b",
    })).toEqual({
      config: {
        name: "n",
        endpoint: "e",
        apiKey: "k",
        deployment: "d",
        apiVersion: "2024-08-01-preview",
        endpoints: ["chat_completions"],
        deployments: [{ name: "a", model: "b" }],
      },
    })
  })

  test("edit sends replace-whole fields and omits blank secrets", () => {
    expect(buildEditConfig("custom", { ...EMPTY, name: "n" })).toEqual({
      name: "n",
      endpoints: ["chat_completions", "embeddings"],
      authStyle: "bearer",
      pathOverrides: {},
      modelsEndpoint: "",
      models: [],
    })
    expect(buildEditConfig("azure", { ...EMPTY, name: "n", endpoints: [...AZURE_SERVED_ENDPOINTS] })).toEqual({
      name: "n",
      apiVersion: "2024-08-01-preview",
      endpoints: [...AZURE_SERVED_ENDPOINTS],
      deployments: [],
    })
    expect(buildEditConfig("sdf", { ...EMPTY, name: "n", substrateToken: " t " })).toEqual({
      name: "n",
      substrateToken: "t",
      ...sdfTuning(EMPTY),
    })
  })
})
