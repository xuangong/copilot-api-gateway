import { setResponsesVisionHeader } from "~/transforms"
import type { ResponsesPayload } from "~/transforms"
import type { CopilotInterceptor } from "~/providers/interceptor"

export const withResponsesVisionHeader: CopilotInterceptor = async (inv, _ctx, run) => {
  if (inv.enabledFlags.has("transform-vision-header")) {
    setResponsesVisionHeader(inv.payload as unknown as ResponsesPayload, inv.headers)
  }
  return run()
}
