/**
 * Map a Copilot raw model into a structured ModelEndpoints capability map.
 *
 * Copilot's `/models` exposes:
 *   - `capabilities.type` ∈ {'chat', 'embeddings', ...}
 *   - `capabilities.family` (e.g. 'claude-3.7-sonnet', 'gpt-5', 'o1')
 *   - `supported_endpoints` (e.g. ['/responses', 'ws:/responses']) — on the
 *     newer catalog entries only; the legacy tail (gpt-4o and older) omits it.
 *
 * When `supported_endpoints` is present it is authoritative: inferring from the
 * id prefix used to hand `chat_completions` to every non-gpt-5/o-series model,
 * which Copilot rejects for the Responses-only families (grok-*, mai-code-*)
 * with `unsupported_api_for_model`. Where it is absent we keep inferring.
 *
 * Hardcoded workaround: `claude-*` always carries `messages`, for the older
 * catalogs that route the Anthropic native path without advertising it.
 */
import type { ModelEndpoints } from "@vibe-llm/protocols/common"
import type { Model } from "./models"

/** Copilot wire path → gateway endpoint kind. */
const ENDPOINT_BY_PATH: Record<string, keyof ModelEndpoints> = {
  "/chat/completions": "chat_completions",
  "/responses": "responses",
  "/v1/messages": "messages",
}

export function copilotModelEndpoints(model: Model): ModelEndpoints {
  const capType = model.capabilities?.type?.toLowerCase()
  if (capType === "embeddings" || capType === "embedding") {
    return { embeddings: {} }
  }

  const id = model.id.toLowerCase()
  const family = (model.capabilities?.family ?? "").toLowerCase()
  const endpoints: ModelEndpoints = {}

  // Reasoning families served via Responses upstream: gpt-5*, o1*, o3*, o4*.
  // For gpt-5.x specifically, Copilot rejects the legacy `max_tokens` parameter
  // on /chat/completions ("Use 'max_completion_tokens' instead") even when the
  // catalog advertises that path. Suppressing chat_completions here forces the
  // pair selector to fall back to responses, where the
  // chat_completions→responses translator handles the param mapping — so for
  // this family the catalog may only ever narrow, never widen.
  const isReasoning = id.startsWith("gpt-5") || /^o[134](-|$)/.test(id)

  // `ws:` entries are a different transport for a path we already cover, not a
  // separate protocol, so they carry no endpoint kind of their own.
  const advertised = model.supported_endpoints?.filter((path) => !path.startsWith("ws:"))

  if (advertised?.length) {
    for (const path of advertised) {
      const kind = ENDPOINT_BY_PATH[path]
      if (!kind) continue
      if (kind === "chat_completions" && isReasoning) continue
      endpoints[kind] = {}
    }
    // gpt-5's suppression can empty the map; the family is Responses-served by
    // definition, so restore the path the suppression assumed was there.
    if (isReasoning) endpoints.responses = {}
  } else {
    // Anthropic native path — catalogs without `supported_endpoints` also
    // under-report this, so force-add it per the long-standing workaround.
    if (id.startsWith("claude-") || family.startsWith("claude")) {
      endpoints.messages = {}
    }

    // xAI and MAI are Responses-only too, but for no reason of ours — there is
    // no parameter to work around, so this is only a safety net for a silent
    // catalog, never an override of one that speaks.
    if (isReasoning || id.startsWith("grok-") || id.startsWith("mai-code-")) {
      endpoints.responses = {}
    } else {
      // chat_completions is otherwise universally supported across Copilot's
      // legacy chat models.
      endpoints.chat_completions = {}
    }
  }

  // Needed by the gemini → messages translator for non-claude models, and
  // never advertised by Copilot on any entry.
  endpoints.messages_count_tokens = {}

  return endpoints
}
