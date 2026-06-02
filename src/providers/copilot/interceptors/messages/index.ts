import type { CopilotInterceptor } from "~/providers/interceptor"
import { withClaudeAgentHeaders } from "./with-claude-agent-headers"
import { withCompactHeaders } from "./with-compact-headers"
import { withInteractionIdHeader } from "./with-interaction-id-header"
import { withMessagesVisionHeader } from "./with-vision-header"
import { withStructuredOutputFormatStripped } from "./with-structured-output-format-stripped"
import { withInlineImagesCompressed } from "./with-inline-images-compressed"
import { withMessagesCacheBreakpointsAttached } from "./with-cache-breakpoints-attached"

/**
 * Canonical order mirrors the if-block sequence currently in
 * CopilotProvider.fetch(). DO NOT reorder without verifying the comment
 * in setCompactHeaders() about running AFTER initiator + claude-agent-headers.
 */
export const messagesPayloadInterceptors: readonly CopilotInterceptor[] = [
  withClaudeAgentHeaders,
  withCompactHeaders,
  withInteractionIdHeader,
  withMessagesVisionHeader,
  withStructuredOutputFormatStripped,
  withInlineImagesCompressed,
  withMessagesCacheBreakpointsAttached,
]
