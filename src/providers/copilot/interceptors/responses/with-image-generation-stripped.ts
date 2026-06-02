import { stripImageGeneration } from "~/transforms"
import type { ResponsesPayload } from "~/transforms"
import type { CopilotInterceptor } from "~/providers/interceptor"

export const withImageGenerationStripped: CopilotInterceptor = async (inv, _ctx, run) => {
  if (inv.enabledFlags.has("transform-strip-image-generation")) {
    stripImageGeneration(inv.payload as unknown as ResponsesPayload)
  }
  return run()
}
