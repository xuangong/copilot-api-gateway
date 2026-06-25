import type { CopilotInterceptor } from "@vibe-llm/protocols/common"
import { withCountTokensPrelude } from "./with-count-tokens-prelude"

export const messagesCountTokensPayloadInterceptors: readonly CopilotInterceptor[] = [
  withCountTokensPrelude,
]
