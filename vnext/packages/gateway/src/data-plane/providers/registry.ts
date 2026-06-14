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
import type { UpstreamRecord } from '../../shared/repo/types.ts'
import { getRepo } from '../../shared/repo/index.ts'
import { __registerPlatformReset } from '@vnext/platform'
import { getCache } from '../../shared/cache/index.ts'
import type { Model, ModelsResponse } from '@vnext/provider-copilot'
import { copilotModelEndpoints } from '@vnext/provider-copilot'
import type { ModelProvider, ProviderBinding } from '@vnext/provider'
import type { EndpointKey, ModelEndpoints, UpstreamKind } from '@vnext/protocols/common'
import { CopilotProvider } from '@vnext/provider-copilot'
import { CustomProvider, type CustomProviderConfig } from '@vnext/provider-custom'
import { AzureProvider, type AzureProviderConfig } from '@vnext/provider-azure'
import { SdfProvider, type SdfProviderConfig } from '@vnext/provider-sdf'
import { getCachedCopilotToken } from '../../shared/copilot-token-cache.ts'

export interface CreateProviderOptions {
  copilotToken: string
  accountType: AccountType
}

export interface ListUpstreamModelsOptions {
  ownerId?: string
  copilot?: CreateProviderOptions
}

export function createCopilotProvider(opts: CreateProviderOptions): ModelProvider {
  return new CopilotProvider({ copilotToken: opts.copilotToken, accountType: opts.accountType })
}

/**
 * Build a ModelProvider from a stored upstream row. Returns null when a
 * Copilot upstream lacks a github token AND no fallback `copilot` opts were
 * passed; custom/azure upstreams construct from their stored config.
 *
 * Note: CustomProvider/AzureProvider constructors VALIDATE config and throw
 * Error on missing apiKey/baseUrl/endpoint/deployment/apiVersion. Callers
 * that want to translate that into HTTP 4xx must wrap in try/catch
 * themselves (see control-plane upstream-probe).
 */
export async function createProviderFromUpstream(
  upstream: UpstreamRecord,
  copilot?: CreateProviderOptions,
): Promise<ModelProvider | null> {
  if (upstream.provider === 'custom') {
    return new CustomProvider(upstream.config as unknown as CustomProviderConfig)
  }
  if (upstream.provider === 'azure') {
    return new AzureProvider(upstream.config as unknown as AzureProviderConfig)
  }
  if (upstream.provider === 'sdf') {
    return new SdfProvider(upstream.config as unknown as SdfProviderConfig)
  }
  if (upstream.provider !== 'copilot') return null
  const config = upstream.config
  const accountType = (config.accountType as AccountType | undefined) ?? 'individual'
  if (typeof config.githubToken === 'string' && config.githubToken) {
    try {
      const copilotToken = await getCachedCopilotToken(config.githubToken, accountType)
      return createCopilotProvider({ copilotToken, accountType })
    } catch {
      return copilot ? createCopilotProvider(copilot) : null
    }
  }
  return copilot ? createCopilotProvider(copilot) : null
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
  if (Object.keys(out).length === 0) out.chat_completions = {}
  return out
}

function modelToBindingModel(
  model: ModelsResponse['data'][number],
  kind: UpstreamKind,
  supportedEndpoints: readonly EndpointKey[],
): ProviderBinding['model'] {
  const endpoints = kind === 'copilot'
    ? copilotModelEndpoints(model as Model)
    : genericModelEndpoints(model as Model, supportedEndpoints)
  return {
    id: model.id,
    displayName: model.name,
    ownedBy: model.vendor,
    endpoints,
    limits: model.capabilities?.limits ? {
      maxContextWindowTokens: model.capabilities.limits.max_context_window_tokens,
      maxOutputTokens: model.capabilities.limits.max_output_tokens,
      maxPromptTokens: model.capabilities.limits.max_prompt_tokens,
    } : undefined,
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

async function getCachedModels(
  upstream: UpstreamRecord,
  provider: ModelProvider,
): Promise<ModelsResponse> {
  const key = `models:${upstream.id}@${upstream.updatedAt}`
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
  const models = await provider.getModels()
  modelsMemo.set(key, { expiresAt: now + MODELS_MEMO_TTL_MS, models })
  try {
    await getCache().set(key, models, MODELS_L2_TTL_SEC)
  } catch {
    // L2 write failure is non-fatal; L1 still serves this isolate.
  }
  return models
}

/** Clears the in-process /models memo. Test-only. */
export function _clearModelsMemoForTest(): void {
  modelsMemo.clear()
}

// Auto-clear when test harness swaps repos or cache so a stale cached /models from a
// previous test can't bleed into the next one.
__registerPlatformReset(() => modelsMemo.clear())

function sortUpstreams(upstreams: UpstreamRecord[]): UpstreamRecord[] {
  return upstreams.sort((a, b) =>
    a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  )
}

async function listVisibleUpstreams(ownerId?: string): Promise<UpstreamRecord[]> {
  if (ownerId !== undefined) {
    const [globalUpstreams, ownerUpstreams] = await Promise.all([
      getRepo().upstreams.list({ ownerId: '' }),
      getRepo().upstreams.list({ ownerId }),
    ])
    const byId = new Map([...globalUpstreams, ...ownerUpstreams].map((u) => [u.id, u]))
    return sortUpstreams([...byId.values()])
  }
  return getRepo().upstreams.list({ ownerId: '' })
}

export async function listProviderBindings(
  opts: ListUpstreamModelsOptions = {},
): Promise<ProviderBinding[]> {
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
      const models = await getCachedModels(upstream, provider)
      const enabledFlags = resolveEffectiveFlags(defaultsForUpstream(upstream.provider), [upstream.flagOverrides])
      const disabled = new Set(upstream.disabledPublicModelIds)
      for (const model of models.data ?? []) {
        if (disabled.has(model.id)) continue
        bindings.push({
          upstream: upstream.id,
          kind: upstream.provider,
          model: modelToBindingModel(model as Model, upstream.provider, provider.supportedEndpoints),
          enabledFlags,
          provider,
        })
      }
    } catch {
      continue
    }
  }

  // Request-scoped Copilot fallback: if no stored Copilot upstream produced
  // bindings, synthesize one from the per-request token in opts.copilot.
  if (!bindings.some((b) => b.kind === 'copilot') && opts.copilot) {
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
  for (const binding of bindings) {
    if (seen.has(binding.model.id)) continue
    seen.add(binding.model.id)
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
      // Provenance — non-standard, SDKs ignore.
      _upstream: binding.upstream,
      _provider: binding.kind,
    } as Model)
  }
  return { object: 'list', data }
}
