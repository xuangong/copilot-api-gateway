import { stripImageGeneration } from "../../../../transforms/index"
import type { ResponsesPayload } from "../../../../transforms/index"
import type { CopilotInterceptor } from "@vnext/interceptor"

export const withImageGenerationStripped: CopilotInterceptor = async (inv, _ctx, run) => {
  if (inv.enabledFlags.has("transform-strip-image-generation")) {
    stripImageGeneration(inv.payload as unknown as ResponsesPayload)
  }
  return run()
}
