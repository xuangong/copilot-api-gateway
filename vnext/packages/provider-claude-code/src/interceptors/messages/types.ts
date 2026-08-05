import type { MessagesPayload } from '@vibe-llm/protocols/messages'
import type { ClaudeCodeProviderModel } from '../../models'

// Boundary ctx for Claude Code Messages interceptors. The chain runs only on
// the re-mimicry path; callClaudeCodeMessages decides shaped-vs-unshaped before
// entering the chain. `upstreamId` is required by synthesize-metadata-user-id
// to derive deterministic device/session ids that stay stable per upstream
// across requests (so prompt-cache hits depend on conversation content only,
// not on per-call randomness).
export interface MessagesBoundaryCtx {
  payload: MessagesPayload
  readonly model: ClaudeCodeProviderModel
  readonly upstreamId: string
}
