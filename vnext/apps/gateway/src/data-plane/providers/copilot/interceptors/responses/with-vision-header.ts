import { setResponsesVisionHeader } from "../../../../transforms/index"
import type { ResponsesPayload } from "../../../../transforms/index"
import type { CopilotInterceptor } from "../../../../interceptors/runner"

export const withResponsesVisionHeader: CopilotInterceptor = async (inv, _ctx, run) => {
  if (inv.enabledFlags.has("transform-vision-header")) {
    setResponsesVisionHeader(inv.payload as unknown as ResponsesPayload, inv.headers)
  }
  return run()
}
