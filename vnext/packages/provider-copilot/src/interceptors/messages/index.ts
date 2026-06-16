import type { CopilotInterceptor } from "@vnext/interceptor"
import { withClaudeAgentHeaders } from "./with-claude-agent-headers"
import { withCompactHeaders } from "./with-compact-headers"
import { withInteractionIdHeader } from "./with-interaction-id-header"
import { withMessagesVisionHeader } from "./with-vision-header"
import { withTopLevelCacheControlApplied } from "./with-top-level-cache-control-applied"
import { withCacheControlExtensionsStripped } from "./with-cache-control-extensions-stripped"
import { withEagerInputStreamingStripped } from "./with-eager-input-streaming-stripped"
import { withToolStrictStripped } from "./with-tool-strict-stripped"
import { withStructuredOutputFormatStripped } from "./with-structured-output-format-stripped"
import { withInlineImagesCompressed } from "./with-inline-images-compressed"
import { withMessagesCacheBreakpointsAttached } from "./with-cache-breakpoints-attached"

/**
 * Canonical order — see reference impl (copilot-gateway
 * COPILOT_MESSAGES_BOUNDARY). Header interceptors first, then payload mutators
 * in the order:
 *   topLevelCacheControl → cacheControlExtensionsStripped (must run AFTER so
 *     the auto-applied marker also gets its scope/ttl extensions cleaned)
 *   eagerInputStreamingStripped → toolStrictStripped → structuredOutputFormat
 *     (independent strips, ordered for readability)
 *
 * The provider chain wraps these with createVariantAndBetaFilteringInterceptor
 * (anthropic-beta allowlist), withContextManagementBetaAligned, and
 * withInitiatorHeader — all run at chain start. See provider.ts.
 */
export const messagesPayloadInterceptors: readonly CopilotInterceptor[] = [
  withClaudeAgentHeaders,
  withCompactHeaders,
  withInteractionIdHeader,
  withMessagesVisionHeader,
  withTopLevelCacheControlApplied,
  withCacheControlExtensionsStripped,
  withEagerInputStreamingStripped,
  withToolStrictStripped,
  withStructuredOutputFormatStripped,
  withInlineImagesCompressed,
  withMessagesCacheBreakpointsAttached,
]
