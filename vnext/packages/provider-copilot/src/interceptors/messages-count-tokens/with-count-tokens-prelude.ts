import type { CopilotInterceptor } from "@vnext/protocols/common"
import { runCountTokensPrelude } from "../../transforms/count-tokens-prelude"

export const withCountTokensPrelude: CopilotInterceptor = async (inv, _ctx, next) => {
  if (inv.payload && typeof inv.payload === 'object') {
    runCountTokensPrelude(inv.payload as Record<string, unknown>)
  }
  return next()
}
