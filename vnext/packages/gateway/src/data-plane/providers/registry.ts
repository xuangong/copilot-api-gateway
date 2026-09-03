/**
 * Provider registry — Week 5-prep port of old src/providers/registry.ts.
 *
 * Slimmed for vnext scope: Copilot is the only ported provider today, so
 * Azure/Custom factory branches return null until those providers are
 * ported (tracked separately). The shape of listProviderBindings /
 * listUpstreamModels stays 1:1 with the old project so the orchestrator
 * multi-provider walk (Week 4b follow-up) and /v1/models route can drop
 * straight in.
 *
 * Intentionally NOT ported yet:
 *   - getCachedCopilotToken: token-cache module not in vnext; caller is
 *     expected to pass an already-exchanged copilot token via CreateProviderOptions
 *   - 15s upstreamListCache: premature optimization for the scaffold;
 *     re-introduce once /v1/models route shows it in profiles
 */
import type { AccountType } from '../../shared/config/constants.ts'
import { defaultsForUpstream, resolveEffectiveFlags } from '../flags/index.ts'
import type { UpstreamRecord } from '../../repo/types.ts'
import type { UserId } from '../../repo/branded-ids.ts'
import { getRepo } from '../../repo/index.ts'
import { __registerPlatformReset, getRuntimeLocation } from '@vibe-core/platform'
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
  /** Propagate an upstream catalog failure instead of treating it as empty. */
  strictCatalog?: boolean
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
  if (capType === 'embeddings' || capType === 'embedding') return { embeddings: {} }
  const id = model.id.toLowerCase()
  if (id.split(/[/_\-.]+/).some((tok) => EMBEDDING_TOKENS.has(tok))) {
    return { embeddings: {} }
  }
  if (capType === 'image' || capType === 'images' ||
      id.startsWith('gpt-image') || id.startsWith('dall-e') || id.includes('image-gen')) {
    const out: ModelEndpoints = {}
    if (supported.includes('images_generations')) out.images_generations = {}
    if (supported.includes('images_edits')) out.images_edits = {}
    return Object.keys(out).length > 0 ? out : { images_generations: {} }
  }
  const out: ModelEndpoints = {}
  if (supported.includes('chat_completions')) out.chat_completions = {}
  // No `messages`/`responses`/`embeddings` for chat-typed models on custom/azure
  // unless the upstream explicitly declared them in cfg.endpoints (rare).
  if (supported.includes('responses')) out.responses = {}
  if (supported.includes('messages')) out.messages = {}
  if (supported.includes('embeddings')) out.embeddings = {}
  if (supported.includes('alpha_search')) out.alpha_search = {}
  if (Object.keys(out).length === 0) out.chat_completions = {}
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
  return {
    id: model.id,
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


/**
 * In-process /models memo. Each `listProviderBindings` call previously fetched
 * /models from every visible upstream — N HTTP round-trips per gateway request.
 * Key by `upstream.id + updatedAt` so a control-plane edit invalidates the
 * entry immediately (no need for a manual bust). 120s TTL matches the
 * copilot-gateway reference. Module-level Map works in both Docker
 * (long-lived process) and CFW (shared within an isolate's lifetime).
 */
const MODELS_MEMO_TTL_MS = 120_000
const MODELS_L2_TTL_SEC = 120
const modelsMemo = new Map<string, { expiresAt: number; models: ModelsResponse }>()

const modelsCacheKey = (upstream: UpstreamRecord<unknown>): string =>
  `models:${upstream.id}@${upstream.updatedAt}`

/**
 * Fetches the upstream's model list and writes it to both layers, replacing
 * whatever they held. `getCachedModels` uses it for its miss path.
 *
 * Exported for the control plane's probe route: a probe saves nothing, so
 * `updatedAt` — and with it the key above — is unchanged, and the dashboard's
 * model list would keep serving the pre-probe entry for up to 120s while the
 * probe's own toast reported the live count.
 */
export async function refreshModelsCache(
  upstream: UpstreamRecord<unknown>,
  provider: LlmModelProvider,
): Promise<ModelsResponse> {
  const key = modelsCacheKey(upstream)
  const models = await provider.getModels()
  modelsMemo.set(key, { expiresAt: Date.now() + MODELS_MEMO_TTL_MS, models })
  try {
    await getCache().set(key, models, MODELS_L2_TTL_SEC)
  } catch {
    // L2 write failure is non-fatal; L1 still serves this isolate.
  }
  return models
}

async function getCachedModels(
  upstream: UpstreamRecord<unknown>,
  provider: LlmModelProvider,
): Promise<ModelsResponse> {
  const key = modelsCacheKey(upstream)
  const now = Date.now()

  // L1: in-process memo (Map). Fast, isolate-local.
  const l1 = modelsMemo.get(key)
  if (l1 && l1.expiresAt > now) return l1.models

  // L2: distributed cache (KV/D1/Memory). Survives isolate restarts.
  let l2Hit: ModelsResponse | null = null
  try {
    l2Hit = await getCache().get<ModelsResponse>(key)
  } catch {
    // Bootstrap edge case: cache not yet initialized (e.g. a test that forgot
    // initCache). Behave as a miss so we fall back to upstream.
    l2Hit = null
  }
  if (l2Hit) {
    modelsMemo.set(key, { expiresAt: now + MODELS_MEMO_TTL_MS, models: l2Hit })
    return l2Hit
  }

  // Both miss: fetch upstream + write both layers.
  return refreshModelsCache(upstream, provider)
}

/** Clears the in-process /models memo. Test-only. */
export function _clearModelsMemoForTest(): void {
  modelsMemo.clear()
}

// Auto-clear when test harness swaps repos or cache so a stale cached /models from a
// previous test can't bleed into the next one.
__registerPlatformReset(() => modelsMemo.clear())

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
    try {
      const provider = await createProviderFromUpstream(upstream, opts.copilot, fetcherForUpstream)
      if (!provider) continue
      const models = await getCachedModels(upstream, provider)
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
    } catch {
      return []
    }
  }

  return bindings
}

export async function listUpstreamModels(
  opts: ListUpstreamModelsOptions = {},
): Promise<ModelsResponse> {
  const bindings = await listProviderBindings(opts)
  const data: ModelsResponse['data'] = []
  const seen = new Set<string>()
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
  }
  const dedupe = opts.dedupe !== false
  for (const binding of bindings) {
    if (dedupe && seen.has(binding.model.id)) continue
    seen.add(binding.model.id)
    // Provenance — non-standard, SDKs ignore.
    const provenance = {
      _upstream: binding.upstream,
      _provider: binding.kind,
    }
    if (binding.model.raw) {
      // Root parity (src/providers/registry.ts:listUpstreamModels): spread the
      // upstream model JSON verbatim so vendor fields (`capabilities.family`,
      // `supports.*`, `tokenizer`, `model_picker_category`, `policy`,
      // `supported_endpoints`, `preview`) round-trip unchanged.
      data.push({ ...(binding.model.raw as Record<string, unknown>), ...provenance } as unknown as Model)
      continue
    }
    const supportedEndpoints = Object.keys(binding.model.endpoints ?? {})
      .map((k) => ENDPOINT_PATHS[k])
      .filter((v): v is string => Boolean(v))
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
