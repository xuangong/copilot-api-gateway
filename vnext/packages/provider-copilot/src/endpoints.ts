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
  }

  // Reasoning families served via Responses upstream: gpt-5*, o1*, o3*, o4*.
  // For gpt-5.x specifically, Copilot rejects many models on /chat/completions
  // ("unsupported_api_for_model") or rejects the legacy `max_tokens` parameter
  // ("Use 'max_completion_tokens' instead"). Suppressing chat_completions here
  // forces the pair selector to fall back to responses, where the
  // chat_completions→responses translator handles the param mapping.
  const isReasoning = id.startsWith("gpt-5") || /^o[134](-|$)/.test(id)
  if (isReasoning) {
    endpoints.responses = {}
  }

  // chat_completions + messages_count_tokens are otherwise universally supported
  // across Copilot's chat catalog. count_tokens is needed by the gemini →
  // messages translator for non-claude models like `gemini-3-flash-preview`.
  if (!isReasoning) {
    endpoints.chat_completions = {}
  }
  endpoints.messages_count_tokens = {}

  return endpoints
}
