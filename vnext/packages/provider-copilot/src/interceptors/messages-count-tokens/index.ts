import type { CopilotInterceptor } from "@vnext/protocols/common"
import { withCountTokensPrelude } from "./with-count-tokens-prelude"

export const messagesCountTokensPayloadInterceptors: readonly CopilotInterceptor[] = [
  withCountTokensPrelude,
]
