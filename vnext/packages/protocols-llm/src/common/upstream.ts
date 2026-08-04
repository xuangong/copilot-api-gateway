/**
 * Storage shape for a configured upstream provider row.
 *
 * Lives in @vibe-llm/protocols/common so plugin contracts (@vibe-llm/provider-llm's
 * LlmProviderPlugin) can reference it without depending on the gateway package.
 * Gateway re-exports from src/shared/repo/types.ts to preserve old import
 * paths.
 */
import type { UpstreamKind } from './index'

// TState defaults to null. Providers with no mutable credential state
// (copilot/openai-compat/gemini/…) leave state null and the generic is
// invisible. Providers with rotating credentials (codex OAuth) narrow via
// UpstreamRecord<CodexUpstreamState>; Repo.getById<TState>() /
// saveState<TState>() take the same generic so callers pin the shape at
// read/write time — no `unknown` at consumption points.
//
// Kept separate from `config` so refresh_token rotation doesn't emit a
// config-audit event, and so concurrent rotations go through saveState's
// atomic read-modify-write instead of clobbering each other.
export interface UpstreamRecord<TState = null> {
  id: string
  ownerId?: string
  provider: UpstreamKind
  name: string
  enabled: boolean
  sortOrder: number
  config: Record<string, unknown>
  flagOverrides: Record<string, boolean>
  /** Public model ids hidden from /v1/models and from routing. Empty by default. */
  disabledPublicModelIds: string[]
  state: TState
  createdAt: string
  updatedAt: string
}
