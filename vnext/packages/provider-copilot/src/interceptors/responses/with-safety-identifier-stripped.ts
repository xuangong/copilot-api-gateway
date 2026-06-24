import { stripSafetyIdentifier } from "../../transforms"
import type { ResponsesPayload } from "../../transforms"
import type { CopilotInterceptor } from "@vnext-llm/protocols/common"

export const withSafetyIdentifierStripped: CopilotInterceptor = async (inv, _ctx, run) => {
  const sourceApi = inv.sourceApi ?? "responses"
  if (sourceApi !== "responses" && inv.enabledFlags.has("transform-strip-safety-identifier")) {
    stripSafetyIdentifier(inv.payload as unknown as ResponsesPayload)
  }
  return run()
}
