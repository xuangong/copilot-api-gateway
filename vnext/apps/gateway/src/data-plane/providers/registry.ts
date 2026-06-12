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
import type { UpstreamKind } from '@vnext/protocols/common'
import type { AccountType } from '../../shared/config/constants.ts'
import { defaultsForUpstream, resolveEffectiveFlags } from '../flags/index.ts'
import type { UpstreamRecord } from '../../shared/repo/types.ts'
import { getRepo } from '../../shared/repo/index.ts'
import type { Model, ModelsResponse } from '@vnext/provider-copilot'
import { copilotModelEndpoints } from '@vnext/provider-copilot'
import type { ModelProvider, ProviderBinding } from '@vnext/provider'
import { CopilotProvider } from '@vnext/provider-copilot'
import { CustomProvider, type CustomProviderConfig } from '@vnext/provider-custom'
import { AzureProvider, type AzureProviderConfig } from '@vnext/provider-azure'

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
  if (upstream.provider !== 'copilot') return null
  const config = upstream.config
  if (typeof config.githubToken === 'string' && config.githubToken) {
    // NOTE: old project exchanges githubToken→copilotToken via getCachedCopilotToken.
    // vnext doesn't have that cache module yet; callers handling a Copilot upstream
    // with only a github token must perform the exchange upstream of this call.
    // Falling back to provided opts if available.
    return copilot ? createCopilotProvider(copilot) : null
  }
  return copilot ? createCopilotProvider(copilot) : null
}

function modelToBindingModel(model: ModelsResponse['data'][number]): ProviderBinding['model'] {
  return {
    id: model.id,
    displayName: model.name,
    ownedBy: model.vendor,
    endpoints: copilotModelEndpoints(model as Model),
    limits: model.capabilities?.limits ? {
      maxContextWindowTokens: model.capabilities.limits.max_context_window_tokens,
      maxOutputTokens: model.capabilities.limits.max_output_tokens,
      maxPromptTokens: model.capabilities.limits.max_prompt_tokens,
    } : undefined,
  }
}


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
      const models = await provider.getModels()
      const enabledFlags = resolveEffectiveFlags(defaultsForUpstream(upstream.provider), [upstream.flagOverrides])
      const disabled = new Set(upstream.disabledPublicModelIds)
      for (const model of models.data ?? []) {
        if (disabled.has(model.id)) continue
        bindings.push({
          upstream: upstream.id,
          kind: upstream.provider,
          model: modelToBindingModel(model as Model),
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
          model: modelToBindingModel(model as Model),
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
  for (const binding of bindings) {
    if (seen.has(binding.model.id)) continue
    seen.add(binding.model.id)
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
      // Provenance — non-standard, SDKs ignore.
      _upstream: binding.upstream,
      _provider: binding.kind,
    } as Model)
  }
  return { object: 'list', data }
}
