import type { UpstreamKind } from './index'
import type { UpstreamRecord as CoreUpstreamRecord } from '@vibe-core/upstream'

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
export type UpstreamRecord<TState = null> = CoreUpstreamRecord<UpstreamKind, TState>
