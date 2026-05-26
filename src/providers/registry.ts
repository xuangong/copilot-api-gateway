import type { AccountType } from "~/config/constants"
import { defaultsForUpstream, resolveEffectiveFlags } from "~/flags"
import { getRepo } from "~/repo"
import type { UpstreamRecord } from "~/repo"
import type { ModelEndpoint } from "~/protocols/common"
import { getCachedCopilotToken } from "~/services/github/copilot-token-cache"
import type { ModelsResponse } from "~/services/copilot/models"

import type { ProviderBinding } from "./binding"

import { AzureProvider, type AzureProviderConfig } from "./azure/provider"
import { CopilotProvider } from "./copilot/provider"
import { CustomProvider, type CustomProviderConfig } from "./custom/provider"
import type { ModelProvider, UpstreamKind } from "./types"

export type { ModelProvider, ProviderCallOptions, UpstreamKind } from "./types"
export { CopilotProvider } from "./copilot/provider"
export { CustomProvider, type CustomProviderConfig } from "./custom/provider"
export { AzureProvider, type AzureProviderConfig } from "./azure/provider"

export interface CreateProviderOptions {
  copilotToken: string
  accountType: AccountType
}

export interface ListUpstreamModelsOptions {
  ownerId?: string
  copilot?: CreateProviderOptions
}

const DEFAULT_ENDPOINTS: Record<UpstreamKind, readonly ModelEndpoint[]> = {
  copilot: ["chat_completions", "responses", "messages", "messages_count_tokens", "embeddings"],
  custom: ["chat_completions", "embeddings"],
  azure: ["chat_completions"],
}

/**
 * Build the provider for the current request. Today only Copilot exists; this
 * is the single seam future Azure/custom upstreams will plug into.
 */
export function createCopilotProvider(opts: CreateProviderOptions): ModelProvider {
  return new CopilotProvider({
    copilotToken: opts.copilotToken,
    accountType: opts.accountType,
  })
}

export function createCustomProvider(cfg: CustomProviderConfig): ModelProvider {
  return new CustomProvider(cfg)
}

export function createAzureProvider(cfg: AzureProviderConfig): ModelProvider {
  return new AzureProvider(cfg)
}

export async function createProviderFromUpstream(upstream: UpstreamRecord, copilot?: CreateProviderOptions): Promise<ModelProvider | null> {
  if (upstream.provider === "custom") return createCustomProvider(upstream.config as unknown as CustomProviderConfig)
  if (upstream.provider === "azure") return createAzureProvider(upstream.config as unknown as AzureProviderConfig)
  if (upstream.provider !== "copilot") return null
  const config = upstream.config
  if (typeof config.githubToken === "string" && config.githubToken) {
    const accountType = typeof config.accountType === "string" ? config.accountType as AccountType : "individual"
    // Cache the GitHub→Copilot token exchange across requests. Without this,
    // every binding-resolved request paid one extra ~200-500ms GitHub round
    // trip — the legacy state-driven path had its own cache that the
    // unified upstream path bypassed.
    const cacheRepo = (() => { try { return getRepo().cache } catch { return undefined } })()
    const copilotToken = await getCachedCopilotToken(config.githubToken, accountType, cacheRepo)
    return createCopilotProvider({ copilotToken, accountType })
  }
  return copilot ? createCopilotProvider(copilot) : null
}

function modelToBindingModel(model: ModelsResponse["data"][number]): ProviderBinding["model"] {
  return {
    id: model.id,
    displayName: model.name,
    ownedBy: model.vendor,
    limits: model.capabilities?.limits ? {
      maxContextWindowTokens: model.capabilities.limits.max_context_window_tokens,
      maxOutputTokens: model.capabilities.limits.max_output_tokens,
      maxPromptTokens: model.capabilities.limits.max_prompt_tokens,
    } : undefined,
    raw: model,
  }
}

function sortUpstreams(upstreams: UpstreamRecord[]): UpstreamRecord[] {
  return upstreams.sort((a, b) =>
    a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  )
}

/**
 * Small per-process cache of the visible upstream list. Each request used
 * to incur 1–2 D1 queries even when nothing changed; with this cache the
 * fast-path is a Map lookup. TTL is intentionally short (15s) so config
 * edits propagate quickly even when control-plane invalidate is skipped.
 * Keyed by ownerId (empty string == global-only view).
 */
const UPSTREAM_LIST_TTL_MS = 15_000
const upstreamListCache = new Map<string, { fetchedAt: number; data: UpstreamRecord[] }>()

export function invalidateUpstreamListCache(): void {
  upstreamListCache.clear()
}

async function listVisibleUpstreams(ownerId?: string): Promise<UpstreamRecord[]> {
  const cacheKey = ownerId ?? "__global__"
  const now = Date.now()
  const hit = upstreamListCache.get(cacheKey)
  if (hit && now - hit.fetchedAt < UPSTREAM_LIST_TTL_MS) return hit.data

  let data: UpstreamRecord[]
  if (ownerId !== undefined) {
    const [globalUpstreams, ownerUpstreams] = await Promise.all([
      getRepo().upstreams.list({ ownerId: "" }),
      getRepo().upstreams.list({ ownerId }),
    ])
    const byId = new Map([...globalUpstreams, ...ownerUpstreams].map((upstream) => [upstream.id, upstream]))
    data = sortUpstreams([...byId.values()])
  } else {
    data = await getRepo().upstreams.list({ ownerId: "" })
  }
  upstreamListCache.set(cacheKey, { fetchedAt: now, data })
  return data
}

export async function listProviderBindings(opts: ListUpstreamModelsOptions = {}): Promise<ProviderBinding[]> {
  let upstreams: UpstreamRecord[]
  try {
    upstreams = await listVisibleUpstreams(opts.ownerId)
  } catch {
    upstreams = []
  }

  const bindings: ProviderBinding[] = []
  for (const upstream of upstreams) {
    try {
      const provider = await createProviderFromUpstream(upstream, opts.copilot)
      if (!provider) continue
      const models = await provider.getModels()
      const endpoints = Array.isArray(upstream.config.endpoints)
        ? upstream.config.endpoints as ModelEndpoint[]
        : DEFAULT_ENDPOINTS[upstream.provider]
      const enabledFlags = resolveEffectiveFlags(defaultsForUpstream(upstream.provider), [upstream.flagOverrides])
      for (const model of models.data ?? []) {
        bindings.push({
          upstream: upstream.id,
          kind: upstream.provider,
          model: modelToBindingModel(model),
          upstreamEndpoints: endpoints,
          enabledFlags,
          provider,
        })
      }
    } catch {
      continue
    }
  }

  if (!bindings.some((binding) => binding.kind === "copilot") && opts.copilot) {
    const provider = createCopilotProvider(opts.copilot)
    try {
      const models = await provider.getModels()
      const enabledFlags = defaultsForUpstream("copilot")
      for (const model of models.data ?? []) {
        bindings.push({
          upstream: "copilot:request",
          kind: "copilot",
          model: modelToBindingModel(model),
          upstreamEndpoints: DEFAULT_ENDPOINTS.copilot,
          enabledFlags,
          provider,
        })
      }
    } catch {
      return []
    }
  }

  return bindings
}

export async function listUpstreamModels(opts: ListUpstreamModelsOptions = {}): Promise<ModelsResponse> {
  const bindings = await listProviderBindings(opts)
  const data: ModelsResponse["data"] = []
  const seen = new Set<string>()
  for (const binding of bindings) {
    if (seen.has(binding.model.id)) continue
    seen.add(binding.model.id)
    if (binding.model.raw) {
      data.push(binding.model.raw)
    } else {
      data.push({
        id: binding.model.id,
        object: "model",
        name: binding.model.displayName ?? binding.model.id,
        vendor: binding.model.ownedBy ?? binding.kind,
        version: binding.model.id,
        model_picker_enabled: true,
        preview: false,
        capabilities: {
          family: binding.kind,
          limits: {
            max_context_window_tokens: binding.model.limits?.maxContextWindowTokens,
            max_output_tokens: binding.model.limits?.maxOutputTokens,
            max_prompt_tokens: binding.model.limits?.maxPromptTokens,
          },
          object: "model_capabilities",
          supports: {},
          tokenizer: "unknown",
          type: "text",
        },
      })
    }
  }
  return { object: "list", data }
}

/**
 * Dispatch table for provider kinds. Copilot uses CreateProviderOptions;
 * custom requires its own config and must be created via createCustomProvider
 * directly (the registry-by-kind path remains copilot-only for now).
 */
export function getProvider(kind: UpstreamKind, opts: CreateProviderOptions): ModelProvider {
  if (kind === "copilot") return createCopilotProvider(opts)
  throw new Error(`Provider kind not constructible from CreateProviderOptions: ${kind}`)
}
