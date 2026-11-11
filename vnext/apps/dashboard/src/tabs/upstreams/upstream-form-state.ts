import type * as api from "../../api/upstreams"
import type { UpstreamRecord } from "../../api/types"
import { findPreset } from "./vendorPresets"
import { formatModelsText, parseModelsText } from "./model-text"
import { isFreshCredential } from "./duplicate-draft"
import type { PortableUpstreamDraft } from "./duplicate-draft"

export type Provider = UpstreamRecord["provider"]

export type UpstreamFormMode =
  | { kind: "create"; provider: "azure" | "custom" | "sdf" | "codex"; presetId?: string; draft?: PortableUpstreamDraft }
  | { kind: "edit"; row: UpstreamRecord }

export interface FormState {
  name: string
  baseUrl: string
  apiKey: string
  endpoint: string
  azureApiKey: string
  deployment: string
  apiVersion: string
  endpoints: string[]
  authStyle: string
  pathOverrides: Record<string, string>
  modelsEndpoint: string
  modelsText: string
  azureDeployments: string
  azureDeploymentsError: string
  flagOverrides: Record<string, boolean>
  copilotLogin: string
  substrateToken: string
  sdfExperience: string
  sdfAgent: string
  sdfInferenceStep: string
  sdfTrafficType: string
  sdfServiceTier: string
  sdfPassportEnabled: boolean
  sdfPassportApiBase: string
}

export type UpdateField = <K extends keyof FormState>(key: K, value: FormState[K]) => void

// Mirrors the provider-side defaults. The form always sends these explicitly
// so the card shows exactly what goes on the wire rather than "(default)".
export const SDF_DEFAULTS = {
  experience: "BizChat",
  agent: "Societas",
  inferenceStep: "GenerateResponse",
  trafficType: "Production",
  serviceTier: "default",
  passportApiBase: "https://sdf.passport.microsoft.net",
}

export const SDF_EXPERIENCES = ["BizChat", "WXPOAgents", "AppCopilots", "Cowork", "Scout", "WorkIQ"]
export const SDF_SERVICE_TIERS = ["async", "async-express", "flex", "default", "priority"]
export const SDF_TRAFFIC_TYPES = ["Production", "Test"]

export const EMPTY: FormState = {
  name: "",
  baseUrl: "",
  apiKey: "",
  endpoint: "",
  azureApiKey: "",
  deployment: "",
  apiVersion: "2024-08-01-preview",
  endpoints: ["chat_completions", "embeddings"],
  authStyle: "bearer",
  pathOverrides: {},
  modelsEndpoint: "",
  modelsText: "",
  azureDeployments: "",
  azureDeploymentsError: "",
  flagOverrides: {},
  copilotLogin: "",
  substrateToken: "",
  sdfExperience: SDF_DEFAULTS.experience,
  sdfAgent: SDF_DEFAULTS.agent,
  sdfInferenceStep: SDF_DEFAULTS.inferenceStep,
  sdfTrafficType: SDF_DEFAULTS.trafficType,
  sdfServiceTier: SDF_DEFAULTS.serviceTier,
  sdfPassportEnabled: true,
  sdfPassportApiBase: SDF_DEFAULTS.passportApiBase,
}

// Azure has no `/alpha/search` surface, so it gets one fewer checkbox.
export const CUSTOM_SERVED_ENDPOINTS = [
  "chat_completions",
  "responses",
  "messages",
  "messages_count_tokens",
  "embeddings",
  "images_generations",
  "images_edits",
  "alpha_search",
] as const
export const AZURE_SERVED_ENDPOINTS = CUSTOM_SERVED_ENDPOINTS.filter((ep) => ep !== "alpha_search")

// The 7 override-able endpoint keys and their provider-side defaults.
// messages_count_tokens is absent on purpose — it derives from messages.
export const PATH_OVERRIDE_KEYS = [
  ["chat_completions", "/chat/completions"],
  ["responses", "/responses"],
  ["messages", "/messages"],
  ["embeddings", "/embeddings"],
  ["images_generations", "/images/generations"],
  ["images_edits", "/images/edits"],
  ["alpha_search", "/alpha/search"],
] as const

export function buildInitial(mode: UpstreamFormMode): { provider: Provider; form: FormState } {
  if (mode.kind === "create" && !mode.draft) {
    const preset = mode.provider === "custom" ? findPreset(mode.presetId) : undefined
    if (preset) {
      return {
        provider: mode.provider,
        form: {
          ...EMPTY,
          name: preset.name,
          baseUrl: preset.baseUrl,
          endpoints: [...preset.endpoints],
          pathOverrides: { ...preset.pathOverrides },
          modelsEndpoint: preset.modelsEndpoint,
          modelsText: preset.modelsText,
          flagOverrides: { ...preset.flagOverrides },
        },
      }
    }
    return {
      provider: mode.provider,
      form: {
        ...EMPTY,
        endpoints:
          mode.provider === "azure"
            ? ["chat_completions"]
            : mode.provider === "sdf"
              ? ["images_generations", "images_edits"]
              : ["chat_completions", "embeddings"],
      },
    }
  }
  const u = mode.kind === "edit" ? mode.row : mode.draft
  if (!u) throw new Error("Duplicate draft required")
  const cfg = u.config as UpstreamRecord["config"]
  const sdf = cfg as {
    taxonomy?: { experience?: string; agent?: string; inferenceStep?: string; trafficType?: string }
    cos?: { serviceTier?: string }
    passport?: { enabled?: boolean; apiBase?: string }
  }
  const modelsText = formatModelsText(cfg.models)
  const azureDepsText =
    (Array.isArray((cfg as { deployments?: { name: string; model?: string }[] }).deployments)
      ? (cfg as { deployments: { name: string; model?: string }[] }).deployments
      : [])
      .map((d) => `${d.name}${d.model ? ` = ${d.model}` : ""}`)
      .join("\n")
  return {
    provider: u.provider,
    form: {
      name: u.name,
      baseUrl: u.provider === "custom" ? cfg.baseUrl ?? "" : "",
      apiKey: "",
      endpoint: u.provider === "azure" ? cfg.endpoint ?? "" : "",
      azureApiKey: "",
      deployment: u.provider === "azure" ? cfg.deployment ?? "" : "",
      apiVersion: u.provider === "azure" ? cfg.apiVersion ?? "2024-08-01-preview" : "2024-08-01-preview",
      endpoints: Array.isArray(cfg.endpoints)
        ? [...cfg.endpoints]
        : u.provider === "custom"
          ? ["chat_completions", "embeddings"]
          : u.provider === "sdf"
            ? ["images_generations", "images_edits"]
            : ["chat_completions"],
      authStyle:
        u.provider === "custom" && typeof (cfg as { authStyle?: string }).authStyle === "string"
          ? (cfg as { authStyle: string }).authStyle
          : "bearer",
      pathOverrides:
        u.provider === "custom" && (cfg as { pathOverrides?: Record<string, string> }).pathOverrides
          ? { ...(cfg as { pathOverrides: Record<string, string> }).pathOverrides }
          : {},
      modelsEndpoint:
        u.provider === "custom" ? (cfg as { modelsEndpoint?: string }).modelsEndpoint ?? "" : "",
      modelsText,
      azureDeployments: azureDepsText,
      azureDeploymentsError: "",
      flagOverrides: { ...(u.flagOverrides ?? {}) },
      copilotLogin: u.provider === "copilot" ? cfg.user?.login ?? "" : "",
      substrateToken: "",
      sdfExperience: sdf.taxonomy?.experience ?? SDF_DEFAULTS.experience,
      sdfAgent: sdf.taxonomy?.agent ?? SDF_DEFAULTS.agent,
      sdfInferenceStep: sdf.taxonomy?.inferenceStep ?? SDF_DEFAULTS.inferenceStep,
      sdfTrafficType: sdf.taxonomy?.trafficType ?? SDF_DEFAULTS.trafficType,
      sdfServiceTier: sdf.cos?.serviceTier ?? SDF_DEFAULTS.serviceTier,
      sdfPassportEnabled: sdf.passport?.enabled ?? true,
      sdfPassportApiBase: sdf.passport?.apiBase ?? SDF_DEFAULTS.passportApiBase,
    },
  }
}

/**
 * The PATCH merge is shallow at the top level, so these sub-objects have to be
 * sent whole on every save — a partial `taxonomy` would replace, not merge.
 */
export function sdfTuning(form: FormState) {
  return {
    taxonomy: {
      experience: form.sdfExperience,
      agent: form.sdfAgent.trim() || SDF_DEFAULTS.agent,
      inferenceStep: form.sdfInferenceStep.trim() || SDF_DEFAULTS.inferenceStep,
      trafficType: form.sdfTrafficType,
    },
    cos: { serviceTier: form.sdfServiceTier },
    passport: {
      enabled: form.sdfPassportEnabled,
      apiBase: form.sdfPassportApiBase.trim() || SDF_DEFAULTS.passportApiBase,
    },
  }
}

export function parseAzureDeployments(txt: string): { name: string; model: string }[] | undefined {
  if (!txt.trim()) return undefined
  return txt
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((line) => {
      const eqAt = line.indexOf("=")
      if (eqAt === -1) return { name: line, model: line }
      return { name: line.slice(0, eqAt).trim(), model: line.slice(eqAt + 1).trim() }
    })
}

/**
 * The `config` body for creating a custom, sdf or azure upstream. A missing
 * required field returns the i18n key of the error toast instead.
 */
export function buildCreateConfig(
  provider: Provider,
  form: FormState,
): { config: Record<string, unknown> } | { errorKey: string } {
  let config: Record<string, unknown>
  if (provider === "custom") {
    const needsKey = form.authStyle !== "none"
    if (!form.baseUrl.trim() || (needsKey && !isFreshCredential(form.apiKey))) {
      return { errorKey: "dash.errBaseUrlApiKeyRequired" }
    }
    config = {
      name: form.name.trim(),
      baseUrl: form.baseUrl.trim(),
      endpoints: form.endpoints,
      authStyle: form.authStyle,
      pathOverrides: form.pathOverrides,
    }
    if (isFreshCredential(form.apiKey)) (config as { apiKey: string }).apiKey = form.apiKey.trim()
    if (form.modelsEndpoint.trim()) {
      (config as { modelsEndpoint: string }).modelsEndpoint = form.modelsEndpoint.trim()
    }
    const models = parseModelsText(form.modelsText)
    if (models) (config as { models: unknown }).models = models
  } else if (provider === "sdf") {
    if (!isFreshCredential(form.substrateToken)) {
      return { errorKey: "dash.errSubstrateTokenRequired" }
    }
    config = {
      name: form.name.trim(),
      substrateToken: form.substrateToken.trim(),
      ...sdfTuning(form),
    }
  } else {
    if (!form.endpoint.trim() || !isFreshCredential(form.azureApiKey) || !form.deployment.trim()) {
      return { errorKey: "dash.errEndpointApiKeyDeploymentRequired" }
    }
    config = {
      name: form.name.trim(),
      endpoint: form.endpoint.trim(),
      apiKey: form.azureApiKey.trim(),
      deployment: form.deployment.trim(),
      apiVersion: form.apiVersion.trim() || "2024-08-01-preview",
      endpoints: form.endpoints,
    }
    const deps = parseAzureDeployments(form.azureDeployments)
    if (deps) (config as { deployments: unknown }).deployments = deps
  }
  return { config }
}

/** The `config` body for patching an existing custom, sdf or azure upstream. */
export function buildEditConfig(provider: Provider, form: FormState): Record<string, unknown> {
  const config: Record<string, unknown> = { name: form.name.trim() }
  if (provider === "custom") {
    if (form.baseUrl.trim()) (config as { baseUrl: string }).baseUrl = form.baseUrl.trim()
    if (form.apiKey.trim()) (config as { apiKey: string }).apiKey = form.apiKey.trim()
    ;(config as { endpoints: string[] }).endpoints = form.endpoints
    ;(config as { authStyle: string }).authStyle = form.authStyle
    // Top-level merge is shallow, so this replaces rather than merges —
    // an empty object is how the user clears every override.
    ;(config as { pathOverrides: Record<string, string> }).pathOverrides = form.pathOverrides
    // Blank normalizes back to undefined upstream, which is how the user
    // reverts to probing `${baseUrl}/models`.
    ;(config as { modelsEndpoint: string }).modelsEndpoint = form.modelsEndpoint.trim()
    const models = parseModelsText(form.modelsText)
    ;(config as { models: unknown }).models = models ?? []
  } else if (provider === "sdf") {
    if (form.substrateToken.trim()) {
      (config as { substrateToken: string }).substrateToken = form.substrateToken.trim()
    }
    Object.assign(config, sdfTuning(form))
  } else {
    if (form.endpoint.trim()) (config as { endpoint: string }).endpoint = form.endpoint.trim()
    if (form.azureApiKey.trim()) (config as { apiKey: string }).apiKey = form.azureApiKey.trim()
    if (form.deployment.trim()) (config as { deployment: string }).deployment = form.deployment.trim()
    if (form.apiVersion.trim()) (config as { apiVersion: string }).apiVersion = form.apiVersion.trim()
    ;(config as { endpoints: string[] }).endpoints = form.endpoints
    const deps = parseAzureDeployments(form.azureDeployments)
    ;(config as { deployments: unknown }).deployments = deps ?? []
  }
  return config
}

export interface FlagGroup {
  key: string
  labelKey: string
  flags: api.FlagCatalog["catalog"]
}

export function groupFlags(catalog: api.FlagCatalog["catalog"]): FlagGroup[] {
  const vendor: typeof catalog = []
  const transform: typeof catalog = []
  const behavior: typeof catalog = []
  for (const f of catalog) {
    if (f.id.startsWith("vendor-")) vendor.push(f)
    else if (f.id.startsWith("transform-")) transform.push(f)
    else behavior.push(f)
  }
  const groups: FlagGroup[] = []
  if (vendor.length) groups.push({ key: "vendor", labelKey: "dash.flagGroupVendor", flags: vendor })
  if (behavior.length) groups.push({ key: "behavior", labelKey: "dash.flagGroupBehavior", flags: behavior })
  if (transform.length) groups.push({ key: "transform", labelKey: "dash.flagGroupTransform", flags: transform })
  return groups
}
