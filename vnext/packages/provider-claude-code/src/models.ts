// Claude Code catalog fetch + shape adapter.
//
// Ported from copilot-gateway/packages/provider-claude-code/src/models.ts.
//
// vNext adaptations:
//   - `Fetcher` from local `./fetcher`.
//   - Reference project's `ProviderModel` / `UpstreamChatModelConfig` /
//     `FlagId` were framework-owned types; vNext has no equivalent yet, so
//     we return a plain `ClaudeCodeProviderModel` interface (matches the
//     provider-codex pattern). Dashboard/UI adapters can pick fields.
//   - `enabledFlags` parameter dropped — resolved flag set lives on the
//     upstream record at request time; can be re-added if a downstream
//     consumer needs it.
//   - No semicolons per vNext lint config.
//
// Two id shapes coexist on the wire. Pre-4.6 models (4.5 / 4.1) return with
// a `-YYYYMMDD` date suffix; the public alias is the de-dated form
// (`claude-sonnet-4-5-20250929` → `claude-sonnet-4-5`). 4.6+ and
// `claude-fable-5` return with the alias already. The catalog id we publish
// is always the alias; the original /v1/models id rides on
// `providerData.upstreamModelId` so the wire fetch in `fetch.ts` and the
// pricing table key by the per-revision id.

import { CLAUDE_CODE_HEADERS_SONNET_OPUS } from './headers'
import { pricingForClaudeCodeModelKey } from './pricing'
import type { Fetcher } from './fetcher'
import type { ModelPricing } from '@vibe-llm/protocols/common'

export interface ClaudeCodeProviderData {
  readonly upstreamModelId: string
}

const ANTHROPIC_MODELS_ENDPOINT = 'https://api.anthropic.com/v1/models?limit=100'

// Anthropic extended-thinking minimum `budget_tokens`. Uniform across every
// thinking-capable Claude model; the upper bound is request-relative
// (`budget_tokens < max_tokens`), so `max` is left unset.
const ANTHROPIC_THINKING_BUDGET_MIN = 1024

export interface ClaudeCodeApiModel {
  id: string
  display_name: string
  max_input_tokens: number
  capabilities?: {
    image_input?: { supported: boolean }
    thinking?: {
      types?: {
        enabled?: { supported: boolean }
        adaptive?: { supported: boolean }
      }
    }
    // `supported` is the top-level boolean; other keys are named level
    // sub-objects `{ supported: boolean }`.
    effort?: {
      supported: boolean
      [level: string]: { supported: boolean } | boolean
    }
  }
}

export interface ClaudeCodeProviderModel {
  id: string
  display_name: string
  owned_by: 'anthropic'
  kind: 'chat'
  limits: { max_context_window_tokens: number; max_output_tokens?: number }
  endpoints: { messages: Record<string, never> }
  providerData: ClaudeCodeProviderData
  pricing?: ModelPricing
  chat?: {
    modalities?: { input: readonly ('text' | 'image')[]; output: readonly ['text'] }
    reasoning?: {
      effort?: { supported: readonly string[]; default: string }
      budget_tokens?: { min: number }
      adaptive?: boolean
    }
  }
}

export const fetchClaudeCodeModelsList = async (
  accessToken: string,
  fetcher: Fetcher,
): Promise<ClaudeCodeApiModel[]> => {
  const headers: Record<string, string> = {
    ...CLAUDE_CODE_HEADERS_SONNET_OPUS,
    authorization: `Bearer ${accessToken}`,
  }
  const response = await fetcher(ANTHROPIC_MODELS_ENDPOINT, { method: 'GET', headers })
  if (!response.ok) {
    const body = await response.text()
    throw new Error(
      `Claude Code /v1/models fetch failed: ${response.status} ${body.slice(0, 200)}`,
    )
  }
  const parsed = (await response.json()) as { data?: unknown }
  if (!Array.isArray(parsed.data)) {
    throw new Error('Claude Code /v1/models response missing data array')
  }
  return parsed.data.map(assertApiModel)
}

const assertApiModel = (value: unknown): ClaudeCodeApiModel => {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError('Claude Code /v1/models entry is not an object')
  }
  const { id, display_name, max_input_tokens, capabilities } = value as Record<string, unknown>
  if (typeof id !== 'string') {
    throw new TypeError(
      `Claude Code /v1/models entry missing id: ${JSON.stringify(value).slice(0, 200)}`,
    )
  }
  if (typeof display_name !== 'string') {
    throw new TypeError(`Claude Code /v1/models entry ${id} missing display_name`)
  }
  if (typeof max_input_tokens !== 'number') {
    throw new TypeError(`Claude Code /v1/models entry ${id} missing max_input_tokens`)
  }
  return {
    id,
    display_name,
    max_input_tokens,
    ...(capabilities !== undefined ? { capabilities: parseCapabilities(capabilities) } : {}),
  }
}

// Unknown sub-fields are silently skipped — Anthropic adds capabilities
// forward-compatibly, we'd rather miss a future field than fail refresh.
const parseCapabilities = (raw: unknown): ClaudeCodeApiModel['capabilities'] => {
  if (typeof raw !== 'object' || raw === null) return undefined
  const cap = raw as Record<string, unknown>
  const out: NonNullable<ClaudeCodeApiModel['capabilities']> = {}

  if (typeof cap.image_input === 'object' && cap.image_input !== null) {
    const ii = cap.image_input as Record<string, unknown>
    if (typeof ii.supported === 'boolean') out.image_input = { supported: ii.supported }
  }

  if (typeof cap.thinking === 'object' && cap.thinking !== null) {
    const th = cap.thinking as Record<string, unknown>
    const thinking: NonNullable<ClaudeCodeApiModel['capabilities']>['thinking'] = {}
    if (typeof th.types === 'object' && th.types !== null) {
      const types = th.types as Record<string, unknown>
      const parsedTypes: NonNullable<typeof thinking.types> = {}
      if (typeof types.enabled === 'object' && types.enabled !== null) {
        const en = types.enabled as Record<string, unknown>
        if (typeof en.supported === 'boolean') parsedTypes.enabled = { supported: en.supported }
      }
      if (typeof types.adaptive === 'object' && types.adaptive !== null) {
        const ad = types.adaptive as Record<string, unknown>
        if (typeof ad.supported === 'boolean') parsedTypes.adaptive = { supported: ad.supported }
      }
      if (parsedTypes.enabled !== undefined || parsedTypes.adaptive !== undefined) {
        thinking.types = parsedTypes
      }
    }
    if (thinking.types !== undefined) out.thinking = thinking
  }

  // `effort.supported` is required to interpret the block; skip otherwise.
  if (typeof cap.effort === 'object' && cap.effort !== null) {
    const eff = cap.effort as Record<string, unknown>
    if (typeof eff.supported === 'boolean') {
      const effort: NonNullable<ClaudeCodeApiModel['capabilities']>['effort'] = {
        supported: eff.supported,
      }
      for (const [level, levelVal] of Object.entries(eff)) {
        if (level === 'supported') continue
        if (typeof levelVal === 'object' && levelVal !== null) {
          const lv = levelVal as Record<string, unknown>
          if (typeof lv.supported === 'boolean') effort[level] = { supported: lv.supported }
        }
      }
      out.effort = effort
    }
  }

  return Object.keys(out).length > 0 ? out : undefined
}

// Pre-4.6 ids: `claude-<family>-<digits>-<digits>-YYYYMMDD` → drop suffix.
// Newer ids (`claude-opus-4-7`, `claude-fable-5`) pass through unchanged.
// Intentionally generic over family slug so a future family Anthropic ships
// isn't silently dropped.
export const aliasFromApiId = (apiId: string): string => apiId.replace(/-\d{8}$/, '')

// Derives the `chat` metadata from a capabilities block. Returns undefined
// when no relevant capability is present so the caller can omit the key.
export const chatFromCapabilities = (
  capabilities: ClaudeCodeApiModel['capabilities'],
): ClaudeCodeProviderModel['chat'] | undefined => {
  if (capabilities === undefined) return undefined

  const chat: NonNullable<ClaudeCodeProviderModel['chat']> = {}

  if (capabilities.image_input?.supported === true) {
    chat.modalities = { input: ['text', 'image'], output: ['text'] }
  }

  const reasoning: NonNullable<NonNullable<ClaudeCodeProviderModel['chat']>['reasoning']> = {}

  const eff = capabilities.effort
  if (eff?.supported === true) {
    const supportedLevels = Object.entries(eff)
      .filter(
        ([key, val]) =>
          key !== 'supported' &&
          typeof val === 'object' &&
          val !== null &&
          (val as { supported: boolean }).supported === true,
      )
      .map(([key]) => key)
    if (supportedLevels.length > 0) {
      const defaultLevel = supportedLevels.includes('medium') ? 'medium' : supportedLevels[0]!
      reasoning.effort = { supported: supportedLevels, default: defaultLevel }
    }
  }

  if (capabilities.thinking?.types?.enabled?.supported === true) {
    reasoning.budget_tokens = { min: ANTHROPIC_THINKING_BUDGET_MIN }
  }

  if (capabilities.thinking?.types?.adaptive?.supported === true) {
    reasoning.adaptive = true
  }

  if (
    reasoning.effort !== undefined ||
    reasoning.budget_tokens !== undefined ||
    reasoning.adaptive !== undefined
  ) {
    chat.reasoning = reasoning
  }

  return chat.modalities !== undefined || chat.reasoning !== undefined ? chat : undefined
}

export const buildClaudeCodeCatalog = (
  apiModels: readonly ClaudeCodeApiModel[],
): ClaudeCodeProviderModel[] =>
  apiModels.map((api) => {
    const alias = aliasFromApiId(api.id)
    const pricing = pricingForClaudeCodeModelKey(api.id)
    const providerData: ClaudeCodeProviderData = { upstreamModelId: api.id }
    const chat = chatFromCapabilities(api.capabilities)
    return {
      id: alias,
      display_name: api.display_name,
      owned_by: 'anthropic',
      kind: 'chat',
      endpoints: { messages: {} },
      limits: { max_context_window_tokens: api.max_input_tokens },
      providerData,
      ...(pricing ? { pricing } : {}),
      ...(chat ? { chat } : {}),
    }
  })
