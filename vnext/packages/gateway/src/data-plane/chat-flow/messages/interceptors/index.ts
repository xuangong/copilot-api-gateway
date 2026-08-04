import type { MessagesInterceptor } from './types'
import { withBillingAttributionStripped } from './with-billing-attribution-stripped'
import { withContextWindowErrorRewritten } from './with-context-window-error-rewritten'
import { withMessagesWebSearchShim } from './with-messages-web-search-shim'
import { withRoleCompatibilityApplied } from './with-role-compatibility-applied'
import { withSpeedFast } from './with-speed-fast'
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
//   - `withSpeedFast` strips `speed: 'fast' | 'standard'` from the outbound
//     payload (Copilot rejects unknown fields) and stamps `usage.speed='fast'`
//     onto `message_start` / `message_delta` frames when the caller asked for
//     Fast Mode. Runs OUTSIDE `withThinkingDisplayPromoted` so its usage
//     stamping happens after thinking-omit frame filtering; runs INSIDE
//     `withContextWindowErrorRewritten` so error rewrites still see the
//     original event stream.
//   - `withThinkingDisplayPromoted` upgrades `thinking.display` to
//     `summarized` upstream when the downstream wanted `omitted` (Claude 4.7
//     default), then strips thinking text after the fact while preserving
//     every `signature` byte. Without this Claude 4.7 long-thinking turns
//     hit a ~60s idle gap that surfaces as `Stream idle timeout`.
//   - `withBillingAttributionStripped` removes Claude Code's per-turn
//     `x-anthropic-billing-header` + `cch=<hash>` from `payload.system` so
//     non-claude-code upstreams' prompt caches are not busted every turn.
//     Positioned INSIDE `withThinkingDisplayPromoted` (which only cares
//     about thinking blocks, not system) so both can freely mutate the
//     payload without ordering coupling; positioned OUTSIDE the web-search
//     shim so the shim sees the already-cleaned system.
//   - `withMessagesWebSearchShim` (innermost) intercepts native `web_search`
//     tool declarations on Messages API. Ported 1:1 from the reference
//     copilot-gateway; gated by the `messages-web-search-shim` flag on
//     `Invocation.enabledFlags`. See file header for adaptation notes.
//   - `withRoleCompatibilityApplied` demotes any interleaved `role:'system'`
//     message that appears after the leading system run into `role:'user'`.
//     Flag-gated by `demote-interleaved-system-to-user`. Positioned innermost
//     (after billing-attribution + web-search shim) so the rewrite is the
//     final payload mutation before terminal dispatch.
export const messagesInterceptors: readonly MessagesInterceptor[] = [
  withContextWindowErrorRewritten,
  withSpeedFast,
  withThinkingDisplayPromoted,
  withBillingAttributionStripped,
  withMessagesWebSearchShim,
  withRoleCompatibilityApplied,
]
