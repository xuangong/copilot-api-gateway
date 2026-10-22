import type { EndpointKey, ModelEndpoints } from "@vibe-llm/protocols/common"
import { normalizeLokiBilling } from "./pricing"

export const LOKI_PATHS = { messages: "/v1/messages", responses: "/responses", chat_completions: "/chat/completions" } as const
export type LokiEndpoint = keyof typeof LOKI_PATHS
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}

export function lokiModelEndpoints(value: unknown): ModelEndpoints {
  const source = record(value)
  const advertised = source.supported_endpoints
  const result: ModelEndpoints = {}
  if (!Array.isArray(advertised)) return result
  for (const endpoint of Object.keys(LOKI_PATHS) as LokiEndpoint[]) {
    if (advertised.includes(LOKI_PATHS[endpoint])) result[endpoint] = {}
  }
  return result
}

export function normalizeLokiModels(value: unknown) {
  const entries = record(value).data
  if (!Array.isArray(entries)) throw new Error("loki_invalid_catalog")
  const data = []
  const seen = new Set<string>()
  for (const value of entries) {
    const model = record(value)
    if (typeof model.id !== "string" || !model.id || model.id.length > 512 || seen.has(model.id)) continue
    const endpoints = lokiModelEndpoints(model)
    if (Object.keys(endpoints).length === 0) continue
    const limits = record(record(model.capabilities).limits)
    const validLimit = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined
    data.push({
      id: model.id, object: "model", name: typeof model.display_name === "string" ? model.display_name : model.id,
      vendor: typeof model.publisher === "string" ? model.publisher : "Loki", version: model.id,
      model_picker_enabled: true, preview: false,
      billing: normalizeLokiBilling(model.billing),
      supported_endpoints: (Object.keys(endpoints) as LokiEndpoint[]).map(endpoint => LOKI_PATHS[endpoint]),
      capabilities: { family: "loki", object: "model_capabilities", supports: {}, tokenizer: "unknown", type: "text", limits: {
        max_context_window_tokens: validLimit(limits.max_context_window_tokens),
        max_output_tokens: validLimit(limits.max_output_tokens),
      } },
    })
    seen.add(model.id)
  }
  return { object: "list", data }
}

export const isLokiEndpoint = (endpoint: EndpointKey): endpoint is LokiEndpoint => Object.hasOwn(LOKI_PATHS, endpoint)
