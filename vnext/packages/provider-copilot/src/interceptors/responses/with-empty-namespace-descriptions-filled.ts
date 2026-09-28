import type { CopilotInterceptor } from "@vibe-llm/protocols/common"
import { fillEmptyNamespaceDescriptions } from "@vibe-llm/provider-llm"

export const withEmptyNamespaceDescriptionsFilled: CopilotInterceptor = async (inv, _ctx, run) => {
  inv.payload = fillEmptyNamespaceDescriptions(inv.payload) as typeof inv.payload
  return run()
}
