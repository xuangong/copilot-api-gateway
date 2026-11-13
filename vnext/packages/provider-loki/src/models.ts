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

/**
 * What Loki reported for these names on 2026-11-12. A static catalog skips
 * discovery, so without this a configured name would route but carry no price
 * (its usage would go unpriced) and no context window. Names not listed keep
 * the prefix-based endpoint and stay unpriced.
 */
const LOKI_KNOWN_MODELS = new Map<string, Record<string, unknown>>([
  { id: "claude-opus-5.5", display_name: "claude-opus-5.5", publisher: "Anthropic", supported_endpoints: ["/v1/messages"],
    capabilities: { limits: { max_context_window_tokens: 1_000_000 } },
    billing: { price_unit: "CopilotCredit", cost_per_input_token: 0.00044, cost_per_output_token: 0.0022, cache_read_cost_per_token: 0.000022, cache_write_cost_per_token: 0.00055 } },
  { id: "claude-opus-5", display_name: "claude-opus-5", publisher: "Anthropic", supported_endpoints: ["/v1/messages"],
    capabilities: { limits: { max_context_window_tokens: 1_000_000 } },
    billing: { price_unit: "CopilotCredit", cost_per_input_token: 0.00055, cost_per_output_token: 0.00275, cache_read_cost_per_token: 0.000055, cache_write_cost_per_token: 0.000688 } },
  { id: "claude-sonnet-5.5", display_name: "claude-sonnet-5.5", publisher: "Anthropic", supported_endpoints: ["/v1/messages"],
    capabilities: { limits: { max_context_window_tokens: 1_000_000 } },
    billing: { price_unit: "CopilotCredit", cost_per_input_token: 0.00022, cost_per_output_token: 0.0011, cache_read_cost_per_token: 0.000022, cache_write_cost_per_token: 0.000275 } },
  { id: "claude-sonnet-5", display_name: "claude-sonnet-5", publisher: "Anthropic", supported_endpoints: ["/v1/messages"],
    capabilities: { limits: { max_context_window_tokens: 1_000_000 } },
    billing: { price_unit: "CopilotCredit", cost_per_input_token: 0.0002, cost_per_output_token: 0.001, cache_read_cost_per_token: 0.00002, cache_write_cost_per_token: 0.00025 } },
  { id: "claude-haiku-5.5", display_name: "claude-haiku-5.5", publisher: "Anthropic", supported_endpoints: ["/v1/messages"],
    capabilities: { limits: { max_context_window_tokens: 1_000_000 } },
    billing: { price_unit: "CopilotCredit", cost_per_input_token: 0.000011, cost_per_output_token: 0.000055, cache_read_cost_per_token: 0.0000011, cache_write_cost_per_token: 0.00001375 } },
  { id: "gpt-5.6-sol", display_name: "gpt-5.6-sol", publisher: "OpenAI", supported_endpoints: ["/responses"],
    capabilities: { limits: { max_context_window_tokens: 1_050_000 } },
    billing: { price_unit: "CopilotCredit", cost_per_input_token: 0.00055, cost_per_output_token: 0.0033, cache_read_cost_per_token: 0.000055, cache_write_cost_per_token: 0.000688 } },
  { id: "gpt-5.6-luna", display_name: "gpt-5.6-luna", publisher: "OpenAI", supported_endpoints: ["/responses"],
    capabilities: { limits: { max_context_window_tokens: 1_050_000 } },
    billing: { price_unit: "CopilotCredit", cost_per_input_token: 0.000022, cost_per_output_token: 0.000132, cache_read_cost_per_token: 0.000002, cache_write_cost_per_token: 0.000028 } },
  { id: "gpt-6-luna", display_name: "gpt-6-luna", publisher: "OpenAI", supported_endpoints: ["/responses"],
    capabilities: { limits: { max_context_window_tokens: 1_050_000 } },
    billing: { price_unit: "CopilotCredit", cost_per_input_token: 0.000011, cost_per_output_token: 0.000055, cache_read_cost_per_token: 0.0000011, cache_write_cost_per_token: 0.00001375 } },
  { id: "gpt-61-sol", display_name: "gpt-61-sol", publisher: "OpenAI", supported_endpoints: ["/responses"],
    capabilities: { limits: { max_context_window_tokens: 1_050_000 } },
    billing: { price_unit: "CopilotCredit", cost_per_input_token: 0.00022, cost_per_output_token: 0.0011, cache_read_cost_per_token: 0.000011, cache_write_cost_per_token: 0.000275 } },
].map(model => [model.id, model]))

/** The catalog entry for a configured static name, in Loki's own /models shape. */
export function lokiStaticModelEntry(id: string): Record<string, unknown> {
  const known = LOKI_KNOWN_MODELS.get(id)
  return known ? structuredClone(known)
    : { id, supported_endpoints: [id.startsWith("claude-") ? LOKI_PATHS.messages : LOKI_PATHS.responses] }
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

export function lokiContextWindow(model: unknown): number | undefined {
  const value = record(record(record(model).capabilities).limits).max_context_window_tokens
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

export const isLokiEndpoint = (endpoint: EndpointKey): endpoint is LokiEndpoint => Object.hasOwn(LOKI_PATHS, endpoint)
