import type { CopilotInterceptor } from "@vnext/interceptor"
import { withCountTokensPrelude } from "./with-count-tokens-prelude"

export const messagesCountTokensPayloadInterceptors: readonly CopilotInterceptor[] = [
  withCountTokensPrelude,
]
