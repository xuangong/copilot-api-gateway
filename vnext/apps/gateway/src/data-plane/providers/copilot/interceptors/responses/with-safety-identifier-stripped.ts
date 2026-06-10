import { stripSafetyIdentifier } from "../../../../transforms/index"
import type { ResponsesPayload } from "../../../../transforms/index"
import type { CopilotInterceptor } from "@vnext/interceptor"

export const withSafetyIdentifierStripped: CopilotInterceptor = async (inv, _ctx, run) => {
  const sourceApi = inv.sourceApi ?? "responses"
  if (sourceApi !== "responses" && inv.enabledFlags.has("transform-strip-safety-identifier")) {
    stripSafetyIdentifier(inv.payload as unknown as ResponsesPayload)
  }
  return run()
}
