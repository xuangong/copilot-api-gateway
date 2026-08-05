// Codex backend rejects requests carrying any of these fields with a
// `Unsupported parameter: <name>` 4xx. They are regular OpenAI Responses API
// fields the ChatGPT-subscription path does not honor. Source-protocol
// translators legitimately set max_output_tokens / temperature / top_p, so we
// strip at the Codex target boundary rather than at translation time.
import type { CopilotInterceptor } from "@vibe-llm/protocols/common"

const CODEX_UNSUPPORTED_BODY_FIELDS = [
  "max_output_tokens",
  "temperature",
  "top_p",
  "frequency_penalty",
  "presence_penalty",
  "user",
  "metadata",
  "prompt_cache_retention",
  "safety_identifier",
  "stream_options",
] as const

export const withUnsupportedFieldsStripped: CopilotInterceptor = async (inv, _ctx, run) => {
  for (const key of CODEX_UNSUPPORTED_BODY_FIELDS) {
    delete inv.payload[key]
  }
  return run()
}
