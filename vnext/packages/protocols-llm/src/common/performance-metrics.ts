export const PERFORMANCE_METRIC_NAMES = ["totalMs", "upstreamMs", "ttftMs", "firstTextMs", "generationMs", "inputTokens", "outputTokens", "cachedInputTokens", "reasoningTokens", "upstreamTps", "overallTps", "gapMs", "maxGapMs"] as const
export type PerformanceMetricName = typeof PERFORMANCE_METRIC_NAMES[number]
export function isPerformanceMetricName(name: string): name is PerformanceMetricName {
  return PERFORMANCE_METRIC_NAMES.some(metric => metric === name)
}

export interface MetricDistribution {
  count: number
  sum: number
  min: number
  max: number
  buckets: Array<{ upper: number; count: number }>
}

export interface PerformanceMetricsGroup {
  keyId: string
  keyName?: string
  incomingModel: string
  model: string
  upstream: string | null
  sourceApi: string
  targetApi: string
  stream: boolean
  runtimeLocation: string
  outcome: "success" | "error" | "cancelled"
  inputBucket: string
  cacheStatus: "hit" | "miss" | "unknown"
  reasoningEffort: string
  requests: number
  metrics: Partial<Record<PerformanceMetricName, MetricDistribution>>
}

export interface PerformanceMetricsResponse {
  version: 2
  groups: PerformanceMetricsGroup[]
  legacyRequests: number
}

export type OutputProtocol = "chat_completions" | "messages" | "responses" | "gemini"

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {}
}
function nonempty(value: unknown): boolean { return typeof value === "string" && value.length > 0 }
function list(value: unknown): unknown[] { return Array.isArray(value) ? value : [] }

/** Classifies a parsed wire event; chunk count is never a token count. */
export function classifyOutputEvent(protocol: OutputProtocol, event: unknown): { output: boolean; text: boolean } {
  const e = object(event)
  let text = false
  let output = false
  if (protocol === "messages" && e.type === "content_block_delta") {
    const delta = object(e.delta)
    text = delta.type === "text_delta" && nonempty(delta.text)
    output = text || (delta.type === "thinking_delta" && nonempty(delta.thinking)) || (delta.type === "input_json_delta" && nonempty(delta.partial_json))
  } else if (protocol === "messages" && e.type === "content_block_start") {
    const block = object(e.content_block)
    text = block.type === "text" && nonempty(block.text)
    output = text || (block.type === "thinking" && nonempty(block.thinking)) || (["tool_use", "server_tool_use"].includes(String(block.type)) && Object.keys(object(block.input)).length > 0)
  } else if (protocol === "responses") {
    text = e.type === "response.output_text.delta" && nonempty(e.delta)
    output = text || (["response.reasoning_text.delta", "response.reasoning_summary_text.delta", "response.function_call_arguments.delta", "response.custom_tool_call_input.delta", "response.refusal.delta"].includes(String(e.type)) && nonempty(e.delta))
  } else if (protocol === "chat_completions") {
    for (const choice of list(e.choices)) {
      const delta = object(object(choice).delta)
      text ||= nonempty(delta.content)
      output ||= text || nonempty(delta.reasoning_text) || nonempty(delta.reasoning_content) || nonempty(delta.reasoning) || nonempty(delta.refusal) || nonempty(object(delta.function_call).arguments)
      for (const tool of list(delta.tool_calls)) output ||= nonempty(object(object(tool).function).arguments)
    }
  } else if (protocol === "gemini") {
    for (const candidate of list(e.candidates)) {
      for (const part of list(object(object(candidate).content).parts)) {
        const p = object(part)
        text ||= nonempty(p.text) && p.thought !== true
        output ||= nonempty(p.text) || (object(p.functionCall).args !== undefined)
      }
    }
  }
  return { output, text }
}
