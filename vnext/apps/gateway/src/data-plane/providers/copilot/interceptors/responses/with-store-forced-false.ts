import { forceStoreFalse } from "../../../../transforms/index"
import type { CopilotInterceptor } from "../../../../interceptors/runner"

export const withStoreForcedFalse: CopilotInterceptor = async (inv, _ctx, run) => {
  if (inv.enabledFlags.has("transform-force-store-false")) {
    forceStoreFalse(inv.payload)
  }
  return run()
}
