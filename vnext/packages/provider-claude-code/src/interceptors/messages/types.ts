import type { MessagesPayload } from '@vibe-llm/protocols/messages'
import type { ClaudeCodeProviderModel } from '../../models'

// Boundary ctx for Claude Code Messages interceptors. The chain runs only on
// the re-mimicry path; `ClaudeCodeProvider.fetch` runs
// `isClaudeCodeShapedRequest` and skips straight to the terminal when the
// caller is already a real Claude Code client. `upstreamId` is required by synthesize-metadata-user-id
// to derive deterministic device/session ids that stay stable per upstream
// across requests (so prompt-cache hits depend on conversation content only,
// not on per-call randomness).
export interface MessagesBoundaryCtx {
  payload: MessagesPayload
  readonly model: ClaudeCodeProviderModel
  readonly upstreamId: string
}
