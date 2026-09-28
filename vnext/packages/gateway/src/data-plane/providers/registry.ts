import { upstreamConfiguration } from "../../repo/upstream-configuration.ts"
import { createHash } from "node:crypto"
import { ConfigurationUnavailableError } from "../../repo/configuration-cache.ts"
/** Provider bindings use shared configuration and retained model catalogs.
 * Credential preparation is deferred until discovery or selected dispatch. */
import type { AccountType } from '../../shared/config/constants.ts'
import { defaultsForUpstream, resolveEffectiveFlags } from '../flags/index.ts'
import type { UpstreamRecord } from '../../repo/types.ts'
import type { UserId } from '../../repo/branded-ids.ts'
import { getDataPlaneRepo as getRepo } from '../../repo/index.ts'
import { __registerPlatformReset, getRuntimeLocation, waitUntil } from '@vibe-core/platform'
import { getCache } from '../../data-plane/cache/index.ts'
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
import { createPerRequestFetcher } from '../dial/per-request.ts'
import type { Fetcher } from '@vibe-core/upstream'
import { supportsOriginalImageDetail } from './catalog-image-detail.ts'

export interface CreateProviderOptions {
  copilotToken: string
  accountType: AccountType
}

export interface ListUpstreamModelsOptions {
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

export function createCopilotProvider(opts: CreateProviderOptions): LlmModelProvider {
  return new CopilotProvider({ copilotToken: opts.copilotToken, accountType: opts.accountType })
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
): Promise<LlmModelProvider | null> {
  const plugin = PROVIDER_PLUGINS.get(upstream.provider)
  if (!plugin) return null
  return plugin.createFromUpstream(upstream, {
    getCachedCopilotToken,
    deferCredentials: true,
    copilotFallback: copilot,
    fetcherForUpstream,
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

function modelToBindingModel(
  model: ModelsResponse['data'][number],
  kind: UpstreamKind,
  supportedEndpoints: readonly EndpointKey[],
): LlmProviderBinding['model'] {
  const endpoints = kind === 'copilot'
    ? copilotModelEndpoints(model as Model)
    : genericModelEndpoints(model as Model, supportedEndpoints)
  const providerData = (model as { providerData?: { upstreamModelId?: unknown } }).providerData
  const providerModelKey = typeof providerData?.upstreamModelId === 'string'
    ? providerData.upstreamModelId
    : undefined
  return {
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
}


/** A refresh deadline never expires the last successful catalog. */
const MODELS_REFRESH_MS = 120_000
const MODELS_RETRY_MS = 30_000
// Bump when provider discovery or projected catalog metadata changes. This is
// independent of the per-upstream configuration hash below.
export const MODEL_CATALOG_REVISION = 4
interface ModelsSnapshot {
  codeRevision: number
  revision: string
  refreshedAt: number
  models: ModelsResponse
}
interface ModelsMemo extends ModelsSnapshot { refreshAfter: number }
const modelsMemo = new Map<string, ModelsMemo>()
const modelsRefreshes = new Map<string, Promise<ModelsResponse>>()

function rememberModels(key: string, entry: ModelsMemo): void {
  const upstreamKey = key.slice(0, key.lastIndexOf('@'))
  for (const previous of modelsMemo.keys()) {
    if (previous.slice(0, previous.lastIndexOf('@')) === upstreamKey) modelsMemo.delete(previous)
  }
  modelsMemo.set(key, entry)
  while (modelsMemo.size > 512) modelsMemo.delete(modelsMemo.keys().next().value!)
}


// Quota telemetry changes state/updatedAt on every response, but does not
// change model availability. Hash configuration rather than exposing credentials
// in storage keys; actual config/credential changes still get a new catalog.
const modelsRevision = (upstream: UpstreamRecord<unknown>): string =>
  createHash('sha256').update(upstreamConfiguration(upstream)).digest('hex')
const modelsCacheKey = (upstream: UpstreamRecord<unknown>): string =>
  `models:${upstream.id}@${modelsRevision(upstream)}`
// A stable storage key avoids accumulating permanent entries on every edit.
// The revision in the value prevents reuse across configuration changes.
const modelsSnapshotKey = (upstream: UpstreamRecord<unknown>): string =>
  `models:snapshot:${upstream.id}`

function validModels(models: ModelsResponse): boolean {
  return models != null && Array.isArray(models.data) &&
    models.data.every((model) => model != null && typeof model.id === 'string' && model.id.length > 0)
}

/** Explicit probes still report refresh errors; only automatic discovery uses stale data. */
export function refreshModelsCache(
  upstream: UpstreamRecord<unknown>,
  provider: LlmModelProvider,
): Promise<ModelsResponse> {
  const key = modelsCacheKey(upstream)
  const pending = modelsRefreshes.get(key)
  if (pending) return pending
  const refresh = (async () => {
    const models = await provider.getModels()
    if (!validModels(models)) throw new Error('Invalid upstream model catalog')
    const snapshot: ModelsSnapshot = {
      codeRevision: MODEL_CATALOG_REVISION,
      revision: modelsRevision(upstream), refreshedAt: Date.now(), models,
    }
    rememberModels(key, { ...snapshot, refreshAfter: snapshot.refreshedAt + MODELS_REFRESH_MS })
    try {
      await getCache().set(modelsSnapshotKey(upstream), snapshot, null)
    } catch {
      // Storage failure must not discard the successful isolate-local snapshot.
    }
    return models
  })().finally(() => { modelsRefreshes.delete(key) })
  modelsRefreshes.set(key, refresh)
  return refresh
}

async function loadModelsSnapshot(upstream: UpstreamRecord<unknown>): Promise<ModelsMemo | null> {
  const key = modelsCacheKey(upstream)
  let snapshot = modelsMemo.get(key)
  if (!snapshot) try {
    const l2 = await getCache().get<ModelsSnapshot>(modelsSnapshotKey(upstream))
    if (l2?.codeRevision === MODEL_CATALOG_REVISION && l2.revision === modelsRevision(upstream)
      && Number.isFinite(l2.refreshedAt) && validModels(l2.models)) {
      snapshot = { ...l2, refreshAfter: l2.refreshedAt + MODELS_REFRESH_MS }
    }
  } catch {
    // A degraded L2 never invalidates the local snapshot.
  }
  // Another caller may have refreshed/backed off while this request read L2.
  const current = modelsMemo.get(key)
  if (current && (!snapshot || current.refreshedAt >= snapshot.refreshedAt)) snapshot = current
  if (snapshot) rememberModels(key, snapshot)
  return snapshot ?? null
}

/** Editor reads known catalog data without contacting the upstream. */
export async function readCachedModels(upstream: UpstreamRecord<unknown>): Promise<ModelsResponse | null> {
  return (await loadModelsSnapshot(upstream))?.models ?? null
}

async function getCachedModels(
  upstream: UpstreamRecord<unknown>,
  provider: LlmModelProvider,
): Promise<ModelsResponse> {
  const key = modelsCacheKey(upstream)
  const snapshot = await loadModelsSnapshot(upstream)
  if (!snapshot) return refreshModelsCache(upstream, provider)
  if (snapshot.refreshAfter > Date.now()) return snapshot.models

  // Return known routes immediately while the next complete catalog is fetched.
  // Concurrent readers use the same refresh and failed discovery is retried later.
  snapshot.refreshAfter = Date.now() + MODELS_RETRY_MS
  const refresh = refreshModelsCache(upstream, provider).catch(() => {
    const retained = modelsMemo.get(key)
    if (retained) retained.refreshAfter = Date.now() + MODELS_RETRY_MS
    console.warn('[registry] catalog refresh failed; retaining snapshot', {
      upstream: upstream.id, provider: upstream.provider, stage: 'models_refresh',
    })
  })
  try {
    waitUntil(refresh)
  } catch {
    // Direct library/test callers may not have a platform background executor.
    await refresh
  }
  return snapshot.models
}

/** Clears isolate-local state, preserving shared storage. Test-only. */
export function _clearModelsMemoForTest(): void {
  modelsMemo.clear()
  modelsRefreshes.clear()
}

__registerPlatformReset(_clearModelsMemoForTest)

function sortUpstreams(upstreams: UpstreamRecord<unknown>[]): UpstreamRecord<unknown>[] {
  return upstreams.sort((a, b) =>
    a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  )
}

async function listVisibleUpstreams(ownerId?: UserId, allOwners = false): Promise<UpstreamRecord<unknown>[]> {
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
  let upstreams: UpstreamRecord<unknown>[]
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

  const bindings: LlmProviderBinding[] = []
  for (const upstream of upstreams) {
    if (!upstream.enabled || (opts.pin && upstream.id !== opts.pin)) continue
    try {
      const provider = await createProviderFromUpstream(upstream, opts.copilot, fetcherForUpstream)
      if (!provider) throw new Error('Unable to construct model provider')
      const models = await getCachedModels(upstream, provider)
      provider.setModelCatalog?.(models)
      const enabledFlags = resolveEffectiveFlags(defaultsForUpstream(upstream.provider), [upstream.flagOverrides])
      const disabled = new Set(upstream.disabledPublicModelIds)
      for (const model of models.data ?? []) {
        const publicId = upstream.provider === 'copilot' ? copilotPublicModelId(model.id) : model.id
        if (disabled.has(publicId)) continue
        bindings.push({
          upstream: upstream.id,
          kind: upstream.provider,
          model: modelToBindingModel(model as Model, upstream.provider, provider.supportedEndpoints),
          enabledFlags,
          provider,
        })
      }
    } catch (err) {
      opts.onCatalogError?.(upstream.id)
      if (opts.strictCatalog) throw err
      console.warn(
        `[registry] upstream ${upstream.id} (${upstream.provider}) contributed no models:`,
        err instanceof Error ? err.message : String(err),
      )
      continue
    }
  }

  // Request-scoped Copilot fallback: if no stored Copilot upstream produced
  // bindings, synthesize one from the per-request token in opts.copilot.
  if (!upstreams.some((upstream) => upstream.provider === 'copilot') && opts.copilot) {
    const provider = createCopilotProvider(opts.copilot)
    try {
      const models = await provider.getModels()
      if (!validModels(models)) throw new Error('Invalid upstream model catalog')
      const enabledFlags = defaultsForUpstream('copilot')
      for (const model of models.data ?? []) {
        bindings.push({
          upstream: 'copilot:request',
          kind: 'copilot',
          model: modelToBindingModel(model as Model, 'copilot', provider.supportedEndpoints),
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
