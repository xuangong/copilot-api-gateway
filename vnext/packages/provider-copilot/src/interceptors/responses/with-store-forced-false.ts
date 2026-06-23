import { forceStoreFalse } from "../../transforms"
import type { CopilotInterceptor } from "@vnext/protocols/common"

export const withStoreForcedFalse: CopilotInterceptor = async (inv, _ctx, run) => {
  if (inv.enabledFlags.has("transform-force-store-false")) {
    forceStoreFalse(inv.payload)
  }
  return run()
}
