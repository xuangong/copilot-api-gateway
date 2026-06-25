/**
 * Map a Copilot raw model into a structured ModelEndpoints capability map.
 *
 * Copilot's `/models` exposes:
 *   - `capabilities.type` ∈ {'chat', 'embeddings', ...}
 *   - `capabilities.family` (e.g. 'claude-3.7-sonnet', 'gpt-5', 'o1')
 *   - `capabilities.supports.streaming` etc.
 * It does NOT expose a `supported_endpoints` list (unlike upstream OpenAI),
 * so we infer per-family.
 *
 * Hardcoded workaround: `claude-*` always carries `messages` because Copilot
 * historically routes Anthropic native path even though no `supported_endpoints`
 * field advertises it.
 */
import type { ModelEndpoints } from "@vibe-llm/protocols/common"
import type { Model } from "./models"

export function copilotModelEndpoints(model: Model): ModelEndpoints {
  const capType = model.capabilities?.type?.toLowerCase()
  if (capType === "embeddings" || capType === "embedding") {
    return { embeddings: {} }
  }

  const id = model.id.toLowerCase()
  const family = (model.capabilities?.family ?? "").toLowerCase()
  const endpoints: ModelEndpoints = {}

  // Anthropic native path — Copilot under-reports this; force-add per workaround.
  if (id.startsWith("claude-") || family.startsWith("claude")) {
    endpoints.messages = {}
    endpoints.messages_count_tokens = {}
  }

  // Reasoning families that prefer Responses API: gpt-5*, o1*, o3*, o4*.
  if (id.startsWith("gpt-5") || /^o[134](-|$)/.test(id)) {
    endpoints.responses = {}
  }

  // chat_completions is universally supported by Copilot's chat type.
  endpoints.chat_completions = {}

  return endpoints
}
