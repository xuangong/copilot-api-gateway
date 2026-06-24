import type { CopilotInterceptor } from "@vnext-llm/protocols/common"
import { withCountTokensPrelude } from "./with-count-tokens-prelude"

export const messagesCountTokensPayloadInterceptors: readonly CopilotInterceptor[] = [
  withCountTokensPrelude,
]
