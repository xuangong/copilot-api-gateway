import type { MessagesInterceptor } from './types'
import { withContextWindowErrorRewritten } from './with-context-window-error-rewritten'
import { withThinkingDisplayPromoted } from './with-thinking-display-promoted'

export type { MessagesInterceptor } from './types'

// Messages stream interceptor registry. Mirrors the chat-completions pattern.
//
// Order (outermost → innermost; first listed wraps last):
//   - `withContextWindowErrorRewritten` runs at the boundary so any Copilot
//     "Request body is too large" / `context_length_exceeded` upstream-error
//     gets reshaped into a Messages-shaped `invalid_request_error` before
//     downstream consumers see it (Claude Code uses this shape to trigger
//     compaction).
//   - `withThinkingDisplayPromoted` upgrades `thinking.display` to
//     `summarized` upstream when the downstream wanted `omitted` (Claude 4.7
//     default), then strips thinking text after the fact while preserving
//     every `signature` byte. Without this Claude 4.7 long-thinking turns
//     hit a ~60s idle gap that surfaces as `Stream idle timeout`.
export const messagesInterceptors: readonly MessagesInterceptor[] = [
  withContextWindowErrorRewritten,
  withThinkingDisplayPromoted,
]
