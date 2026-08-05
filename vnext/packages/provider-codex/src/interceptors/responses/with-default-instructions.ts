// ChatGPT-subscription catalog models reject missing or empty `instructions`.
// Native and translated callers may omit the field, so the provider supplies a
// neutral value at its boundary. Other values remain upstream-owned validation.
import type { CopilotInterceptor } from "@vibe-llm/protocols/common"

export const withDefaultInstructions: CopilotInterceptor = async (inv, _ctx, run) => {
  const current = inv.payload.instructions
  if (current === undefined || current === null || current === "") {
    inv.payload.instructions = "You're a helpful assistant."
  }
  return run()
}
