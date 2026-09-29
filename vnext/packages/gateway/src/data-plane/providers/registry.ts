import { parseOpaqueCompatibilityDeclaration } from "@vibe-llm/provider-llm"
import { catalogWithCopilotVariants } from "@vibe-llm/provider-copilot"
import { CatalogCoordinator, CatalogDeadline, CatalogUnavailableError, type CatalogResult } from "./catalog-coordinator.ts"
import { getRequestSignal } from "../../shared/request-signal.ts"
import { validCatalogModels } from "../../repo/catalogs.ts"
import { ConfigurationUnavailableError } from "../../repo/configuration-cache.ts"
/** Provider bindings use shared configuration and retained model catalogs.
 * Credential preparation is deferred until discovery or selected dispatch. */
import type { AccountType } from '../../shared/config/constants.ts'
import { defaultsForUpstream, resolveEffectiveFlags } from '../flags/index.ts'
import type { Repo, StoredUpstreamRecord, UpstreamRecord } from '../../repo/types.ts'
import type { UserId } from '../../repo/branded-ids.ts'
import { getDataPlaneRepo as getRepo, getRepo as getAuthoritativeRepo } from '../../repo/index.ts'
import { __registerPlatformReset, getRuntimeLocation, waitUntil } from '@vibe-core/platform'
import type { Model, ModelsResponse } from '@vibe-llm/provider-copilot'
import { copilotModelEndpoints, copilotPublicModelId } from '@vibe-llm/provider-copilot'
import type { LlmModelProvider, LlmProviderBinding, LlmProviderPlugin } from '@vibe-llm/provider-llm'
import type { EndpointKey, ModelEndpoints, UpstreamKind } from '@vibe-llm/protocols/common'
import { CopilotProvider, copilotProviderPlugin } from '@vibe-llm/provider-copilot'
import { azureProviderPlugin } from '@vibe-llm/provider-azure'
import { codexProviderPlugin } from '@vibe-llm/provider-codex'
import { claudeCodeProviderPlugin } from '@vibe-llm/provider-claude-code'
import { customProviderPlugin } from '@vibe-llm/provider-custom'
import { sdfProviderPlugin } from '@vibe-llm/provider-sdf'
import { getCachedCopilotToken } from '../../shared/copilot-token-cache.ts'
import { createPerRequestFetcher, createObservedDirectFetcher } from '../dial/per-request.ts'
import { directFetcher, type Fetcher } from '@vibe-core/upstream'
import type { ProviderPluginContext, ExecutionFetcherForRequest } from '@vibe-llm/provider-llm'
import type { DumpAccumulator } from '../../shared/dump/accumulator.ts'
import { operationForProviderRequest } from '../../shared/dump/upstream-dial-adapter.ts'
import { supportsOriginalImageDetail } from './catalog-image-detail.ts'

export interface CreateProviderOptions {
  copilotToken: string
  accountType: AccountType
}

export interface ListUpstreamModelsOptions {
  signal?: AbortSignal
  dump?: DumpAccumulator | null
  ownerId?: string
  copilot?: CreateProviderOptions
  /**
   * Collapse duplicate model ids across upstreams (default true). SDK-facing
   * catalogs must stay deduped; the dashboard needs the full per-upstream
   * mapping so every upstream can show what it actually serves.
   */
  dedupe?: boolean
  /**
   * Ignore owner scoping and include every enabled upstream (default false).
   * Admin-only, and only for the dashboard's per-upstream mapping — SDK-facing
   * catalogs must never leak another owner's models.
   */
  allOwners?: boolean
  pin?: string
  /** Propagate an upstream catalog failure instead of treating it as empty. */
  strictCatalog?: boolean
  /** Track incomplete discovery while still collecting healthy upstreams. */
  onCatalogError?: (upstreamId?: string) => void
}

export function createCopilotProvider(opts: CreateProviderOptions, executionFetcher?: ExecutionFetcherForRequest, fetcher: Fetcher = directFetcher): LlmModelProvider {
  return new CopilotProvider({ copilotToken: opts.copilotToken, accountType: opts.accountType }, fetcher, executionFetcher)
}

/**
 * Build a LlmModelProvider from a stored upstream row by dispatching to the
 * provider's plugin factory. Returns null when no plugin matches the
 * upstream.provider kind, or when the plugin itself returns null
 * (Copilot: missing githubToken AND no fallback opts).
 *
 * Note: Custom/Azure/Sdf plugin factories may construct providers whose
 * constructors validate config and throw on missing apiKey/baseUrl/
 * deployment/etc. Callers wanting HTTP 4xx must wrap in try/catch
 * (see control-plane upstream-probe).
 */
const PROVIDER_PLUGINS = new Map(
  [copilotProviderPlugin, azureProviderPlugin, codexProviderPlugin, claudeCodeProviderPlugin, customProviderPlugin, sdfProviderPlugin]
    .map((p) => [p.kind, p] as const),
) satisfies ReadonlyMap<UpstreamKind, LlmProviderPlugin>

export async function createProviderFromUpstream(
  upstream: UpstreamRecord<unknown>,
  copilot?: CreateProviderOptions,
  fetcherForUpstream?: (upstreamId: string) => Fetcher,
  executionFetcherForUpstream?: ProviderPluginContext["executionFetcherForUpstream"],
): Promise<LlmModelProvider | null> {
  const plugin = PROVIDER_PLUGINS.get(upstream.provider)
  if (!plugin) return null
  return plugin.createFromUpstream(upstream, {
    getCachedCopilotToken,
    deferCredentials: true,
    copilotFallback: copilot,
    fetcherForUpstream,
    executionFetcherForUpstream,
  })
}

/**
 * Endpoint capability inference per upstream kind.
 *
 * Copilot uses a family-aware heuristic (claude→messages, gpt-5/o[134]*→responses)
 * because /models doesn't expose `supported_endpoints`. Custom/Azure must NOT
 * use that heuristic — their model lists come from arbitrary OpenAI-compatible
 * upstreams (DeepSeek, Together, Azure deployments) where a "claude-3.7-sonnet"
 * id does not imply Anthropic-native messages support, and a "gpt-5" id does
 * not imply Responses API support.
 *
 * For custom/azure we narrow by capability.type when present (embeddings/image),
 * otherwise fall back to the upstream's declared supportedEndpoints intersected
 * with what makes sense for a chat-shaped model.
 */
// Token-based embedding family detection — runs when upstream's /models
// response didn't publish an explicit `capabilities.type`. Tokens cover OpenAI
// (text-embedding-3), Voyage, Cohere (embed-*), Mistral (mistral-embed), and
// common local catalogs (bge, e5, gte, uae, nomic). Borrowed from
// copilot-gateway/packages/provider-custom/src/infer-endpoints.ts.
const EMBEDDING_TOKENS = new Set(['embed', 'embedding', 'embeddings', 'bge', 'e5', 'gte', 'uae', 'nomic', 'voyage'])

function genericModelEndpoints(
  model: Model,
  supported: readonly EndpointKey[],
): ModelEndpoints {
  const capType = model.capabilities?.type?.toLowerCase()
  if (capType === 'embeddings' || capType === 'embedding') {
    return supported.includes('embeddings') ? { embeddings: {} } : {}
  }
  const id = model.id.toLowerCase()
  if (id.split(/[/_\-.]+/).some((tok) => EMBEDDING_TOKENS.has(tok))) {
    return supported.includes('embeddings') ? { embeddings: {} } : {}
  }
  if (capType === 'image' || capType === 'images' ||
      id.startsWith('gpt-image') || id.startsWith('dall-e') || id.includes('image-gen')) {
    const out: ModelEndpoints = {}
    if (supported.includes('images_generations')) out.images_generations = {}
    if (supported.includes('images_edits')) out.images_edits = {}
    return out
  }
  const out: ModelEndpoints = {}
  if (supported.includes('chat_completions')) out.chat_completions = {}
  // No `messages`/`responses`/`embeddings` for chat-typed models on custom/azure
  // unless the upstream explicitly declared them in cfg.endpoints (rare).
  if (supported.includes('responses')) out.responses = {}
  if (supported.includes('messages')) out.messages = {}
  if (supported.includes('messages_count_tokens')) out.messages_count_tokens = {}
  if (supported.includes('embeddings')) out.embeddings = {}
  if (supported.includes('alpha_search')) out.alpha_search = {}
  return out
}

export function modelToBindingModel(
  model: ModelsResponse['data'][number],
  kind: UpstreamKind,
  provider: Pick<LlmModelProvider, "supportedEndpoints" | "getOpaqueCompatibilityForModel">,
): LlmProviderBinding['model'] {
  const endpoints = kind === 'copilot'
    ? copilotModelEndpoints(model as Model)
    : genericModelEndpoints(model as Model, provider.supportedEndpoints)
  const providerData = (model as { providerData?: { upstreamModelId?: unknown } }).providerData
  const providerModelKey = typeof providerData?.upstreamModelId === 'string'
    ? providerData.upstreamModelId
    : undefined
  const projected: LlmProviderBinding["model"] = {
    id: model.id,
    ...(providerModelKey !== undefined ? { providerModelKey } : {}),
    displayName: model.name,
    ownedBy: model.vendor,
    endpoints,
    ...(model.capabilities?.limits && {
      limits: {
        maxContextWindowTokens: model.capabilities.limits.max_context_window_tokens,
        maxOutputTokens: model.capabilities.limits.max_output_tokens,
        maxPromptTokens: model.capabilities.limits.max_prompt_tokens,
      },
    }),
    raw: model as unknown as Record<string, unknown>,
  }
  const declaration = provider.getOpaqueCompatibilityForModel?.(projected)
  if (declaration !== undefined) projected.opaqueCompatibility = parseOpaqueCompatibilityDeclaration(declaration)
  return projected
}


// Version 7 rebuilds strictly validated provider-owned opaque compatibility metadata; raw fields grant no authority.
export const MODEL_CATALOG_REVISION = 7
let coordinators = new WeakMap<Repo, CatalogCoordinator>()

function withCatalogSignal(fetcher: Fetcher, signal: AbortSignal): Fetcher {
  return Object.assign((url: string, init: RequestInit) => {
    if (signal.aborted) return Promise.reject(signal.reason)
    return fetcher(url, { ...init, signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal })
  }, { signal })
}
async function authoritativeFetchers(result: Pick<CatalogResult, "upstream" | "proxies">) {
  return createPerRequestFetcher(getRuntimeLocation(), [result.upstream], {
    proxies: { list: async () => [...result.proxies] }, proxyBackoffs: getAuthoritativeRepo().proxyBackoffs,
  })
}
function coordinator(): CatalogCoordinator {
  const repo = getAuthoritativeRepo()
  let current = coordinators.get(repo)
  if (!current) {
    current = new CatalogCoordinator({
      catalogs: repo.catalogs, catalogRevision: MODEL_CATALOG_REVISION, background: waitUntil,
      discover: async (observation, signal) => {
        const factory = await authoritativeFetchers(observation)
        // Request-token fallback cannot be published as a stored account's catalog.
        const provider = await createProviderFromUpstream(observation.upstream, undefined,
          id => withCatalogSignal(factory(id), signal))
        if (!provider) throw new CatalogUnavailableError("unavailable")
        const models = await provider.getModels()
        if (!validCatalogModels(models)) throw new CatalogUnavailableError("invalid_catalog")
        return { ...models, data: models.data.map(model => ({ ...model })) }
      },
    })
    coordinators.set(repo, current)
  }
  return current
}
export interface CatalogReadOptions { signal?: AbortSignal; isVisible?: (row: StoredUpstreamRecord) => boolean }
export function refreshModelsCache(upstream: StoredUpstreamRecord, options: CatalogReadOptions = {}): Promise<CatalogResult | null> {
  return coordinator().read({ expected: upstream, mode: "explicit", signal: options.signal ?? getRequestSignal(), isVisible: options.isVisible ?? (() => true) })
}
export function readCachedModels(upstream: StoredUpstreamRecord, options: CatalogReadOptions = {}): Promise<CatalogResult | null> {
  return coordinator().read({ expected: upstream, mode: "cache-only", signal: options.signal ?? getRequestSignal(), isVisible: options.isVisible ?? (() => true) })
}
function validModels(models: ModelsResponse): boolean {
  return models != null && Array.isArray(models.data) && models.data.every(model => model != null && typeof model.id === "string" && model.id.length > 0)
}
async function requestCatalog(opts: CreateProviderOptions, fetcher: Fetcher, signal?: AbortSignal): Promise<ModelsResponse> {
  const deadline = new CatalogDeadline(20_000, signal)
  try {
    deadline.check()
    const discovery = createCopilotProvider(opts, undefined, withCatalogSignal(fetcher, deadline.signal))
    const models = await deadline.wait(discovery.getModels())
    if (!validModels(models)) throw new CatalogUnavailableError("invalid_catalog")
    return models
  } finally { deadline.dispose() }
}
/** Clears isolate-local state without touching shared SQL. */
export function _clearModelsMemoForTest(): void { coordinators = new WeakMap() }
__registerPlatformReset(_clearModelsMemoForTest)

function sortUpstreams(upstreams: StoredUpstreamRecord[]): StoredUpstreamRecord[] {
  return upstreams.sort((a, b) =>
    a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  )
}

async function listVisibleUpstreams(ownerId?: UserId, allOwners = false): Promise<StoredUpstreamRecord[]> {
  if (allOwners) return sortUpstreams(await getRepo().upstreams.list({}))
  if (ownerId !== undefined) {
    const [globalUpstreams, ownerUpstreams] = await Promise.all([
      getRepo().upstreams.list({ ownerId: '' as UserId }),
      getRepo().upstreams.list({ ownerId }),
    ])
    const byId = new Map([...globalUpstreams, ...ownerUpstreams].map((u) => [u.id, u]))
    return sortUpstreams([...byId.values()])
  }
  return getRepo().upstreams.list({ ownerId: '' as UserId })
}

export async function listProviderBindings(
  opts: ListUpstreamModelsOptions = {},
): Promise<LlmProviderBinding[]> {
  let upstreams: StoredUpstreamRecord[]
  try {
    upstreams = await listVisibleUpstreams(opts.ownerId as UserId | undefined, opts.allOwners)
  } catch (err) {
    if (err instanceof ConfigurationUnavailableError) throw err
    opts.onCatalogError?.()
    if (opts.strictCatalog) throw err
    upstreams = []
  }

  // Built once from the already-loaded rows so each provider dials through its
  // own proxy fallback list. Deliberately uncaught: swallowing it would leave
  // every plugin with no fetcher, i.e. direct egress on a proxy-only host.
  // All six take one via `ctx.fetcherForUpstream` (provider-copilot :27,
  // provider-codex :14, provider-claude-code :14, provider-azure :9,
  // provider-custom :9, provider-sdf :9, each src/plugin.ts). Throwing 5xxes
  // the per-request binding path (routing/candidates.ts:73,
  // routing/binding-resolver.ts:45), not only /v1/models — that is intended.
  const fetcherForUpstream = await createPerRequestFetcher(getRuntimeLocation(), upstreams)

  // Ordinary and observed execution share one catalog and fallback policy.
  // The accumulator owns the context so translated/re-entrant selections share IDs.
  const observation = (() => {
    try { return opts.dump?.upstreamDialObservation() } catch { return undefined }
  })()
  const executionFetcherForUpstream: ProviderPluginContext['executionFetcherForUpstream'] = observation
    ? (upstreamId, request) => {
        const operation = operationForProviderRequest(request)
        return operation
          ? fetcherForUpstream(upstreamId, observation.forOperation({ upstreamId, operation }))
          : fetcherForUpstream(upstreamId)
      }
    : undefined

  const bindings: LlmProviderBinding[] = []
  for (const expected of upstreams) {
    let upstream = expected
    if (!upstream.enabled || (opts.pin && upstream.id !== opts.pin)) continue
    try {
      const requestOnly = upstream.provider === "copilot" && !upstream.config.githubToken ? opts.copilot : undefined
      const accepted = requestOnly ? null : await coordinator().read({
        expected, mode: "automatic", signal: opts.signal ?? getRequestSignal(),
        isVisible: row => row.enabled && (opts.allOwners === true || !row.ownerId || row.ownerId === opts.ownerId),
      })
      if (!accepted && !requestOnly) continue
      if (accepted) upstream = accepted.upstream
      const currentFetcher = accepted ? await authoritativeFetchers(accepted) : fetcherForUpstream
      const currentExecution: ProviderPluginContext["executionFetcherForUpstream"] = observation ? (id, request) => {
        const operation = operationForProviderRequest(request)
        return currentFetcher(id, operation ? observation.forOperation({ upstreamId: id, operation }) : undefined)
      } : executionFetcherForUpstream
      const provider = await createProviderFromUpstream(upstream, requestOnly, currentFetcher, currentExecution)
      if (!provider) throw new CatalogUnavailableError("unavailable")
      let models: ModelsResponse
      if (accepted) models = accepted.snapshot.models as unknown as ModelsResponse
      else if (requestOnly) models = await requestCatalog(requestOnly, currentFetcher(upstream.id), opts.signal ?? getRequestSignal())
      else throw new CatalogUnavailableError("unavailable")
      provider.setModelCatalog?.(models)
      const enabledFlags = resolveEffectiveFlags(defaultsForUpstream(upstream.provider), [upstream.flagOverrides])
      const disabled = new Set(upstream.disabledPublicModelIds)
      const listedModels = upstream.provider === "copilot" ? catalogWithCopilotVariants(models) : models
      for (const model of listedModels.data ?? []) {
        const publicId = upstream.provider === 'copilot' ? model.variant_family ?? copilotPublicModelId(model.id) : model.id
        if (disabled.has(publicId)) continue
        bindings.push({
          upstream: upstream.id,
          kind: upstream.provider,
          model: modelToBindingModel(model as Model, upstream.provider, provider),
          enabledFlags,
          provider,
        })
      }
    } catch (err) {
      opts.onCatalogError?.(upstream.id)
      if (opts.strictCatalog) throw err
      console.warn(
        `[registry] upstream ${upstream.id} (${upstream.provider}) contributed no models:`,
        err instanceof CatalogUnavailableError ? err.code : "unavailable",
      )
      continue
    }
  }

  // Request-scoped Copilot fallback: if no stored Copilot upstream produced
  // bindings, synthesize one from the per-request token in opts.copilot.
  if (!upstreams.some((upstream) => upstream.provider === 'copilot') && opts.copilot) {
    const provider = createCopilotProvider(opts.copilot, observation ? (request) => {
      const operation = operationForProviderRequest(request)
      const upstreamId = 'copilot_request'
      return operation
        ? createObservedDirectFetcher(upstreamId, observation.forOperation({ upstreamId, operation }))
        : directFetcher
    } : undefined)
    try {
      const models = await requestCatalog(opts.copilot, directFetcher, opts.signal ?? getRequestSignal())
      const enabledFlags = defaultsForUpstream('copilot')
      provider.setModelCatalog?.(models)
      const listedModels = catalogWithCopilotVariants(models)
      for (const model of listedModels.data ?? []) {
        bindings.push({
          upstream: 'copilot:request',
          kind: 'copilot',
          model: modelToBindingModel(model as Model, 'copilot', provider),
          enabledFlags,
          provider,
        })
      }
    } catch (err) {
      opts.onCatalogError?.('copilot:request')
      if (opts.strictCatalog) throw err
    }
  }

  return bindings
}

export async function listUpstreamModels(
  opts: ListUpstreamModelsOptions = {},
): Promise<ModelsResponse> {
  const bindings = await listProviderBindings(opts)
  const data: ModelsResponse['data'] = []
  const seen = new Map<string, number>()
  // Map binding.model.endpoints (internal EndpointKey) → SDK-facing path tokens
  // so dashboard filters that look at `supported_endpoints` (`/v1/messages`,
  // `/responses`, `/v1/chat/completions`, `/v1/embeddings`) keep working.
  const ENDPOINT_PATHS: Record<string, string> = {
    messages: '/v1/messages',
    messages_count_tokens: '/v1/messages/count_tokens',
    responses: '/responses',
    chat_completions: '/v1/chat/completions',
    embeddings: '/v1/embeddings',
    images_generations: '/v1/images/generations',
    images_edits: '/v1/images/edits',
  }
  const dedupe = opts.dedupe !== false
  for (const binding of bindings) {
    const previousIndex = seen.get(binding.model.id)
    if (dedupe && previousIndex !== undefined) {
      // One public id may route to several enabled upstreams. Codex can only
      // advertise a single boolean, so every candidate must prove support.
      const previous = data[previousIndex] as Model & { chat?: { image_detail_original?: boolean; modalities?: { input?: string[] } } } | undefined
      const candidate = binding.model.raw as { chat?: { image_detail_original?: boolean; modalities?: { input?: string[] } } } | undefined
      if (previous) previous.chat = {
        ...previous.chat,
        image_detail_original: supportsOriginalImageDetail(previous)
          && supportsOriginalImageDetail(candidate ?? {}),
      }
      continue
    }
    if (previousIndex === undefined) seen.set(binding.model.id, data.length)
    // Provenance — non-standard, SDKs ignore.
    const provenance = {
      _upstream: binding.upstream,
      _provider: binding.kind,
    }
    const supportedEndpoints = Object.keys(binding.model.endpoints ?? {})
      .map((k) => ENDPOINT_PATHS[k])
      .filter((v): v is string => Boolean(v))
    if (binding.model.raw) {
      // Root parity (src/providers/registry.ts:listUpstreamModels): spread the
      // upstream model JSON verbatim so vendor fields (`capabilities.family`,
      // `supports.*`, `tokenizer`, `model_picker_category`, `policy`,
      // `supported_endpoints`, `preview`) round-trip unchanged.
      const raw = binding.model.raw as Record<string, unknown>
      const chat = raw.chat as { image_detail_original?: boolean; modalities?: { input?: string[] } } | undefined
      data.push({ ...raw,
        ...(!Object.hasOwn(raw, 'supported_endpoints') ? { supported_endpoints: supportedEndpoints } : {}),
        ...(chat ? { chat: { ...chat, image_detail_original: supportsOriginalImageDetail({ chat }) } } : {}),
        ...provenance } as unknown as Model)
      continue
    }
    data.push({
      id: binding.model.id,
      object: 'model',
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
        object: 'model_capabilities',
        supports: {},
        tokenizer: 'unknown',
        type: 'text',
      },
      supported_endpoints: supportedEndpoints,
      ...provenance,
    } as Model)
  }
  return { object: 'list', data }
}
