import { stripStructuredOutputFormat } from "~/transforms"
import type { AnthropicMessagesPayload } from "~/transforms"
import type { CopilotInterceptor } from "~/providers/interceptor"

export const withStructuredOutputFormatStripped: CopilotInterceptor = async (inv, _ctx, run) => {
  if (inv.enabledFlags.has("transform-strip-structured-output-format")) {
    stripStructuredOutputFormat(inv.payload as unknown as AnthropicMessagesPayload)
  }
  return run()
}
