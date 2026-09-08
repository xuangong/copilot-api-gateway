import { classifyOutputEvent, type MetricDistribution, type OutputProtocol, type PerformanceMetricName, type PerformanceMetricsGroup } from "@vibe-llm/protocols/common"

type TokenMetric = "inputTokens" | "outputTokens" | "cachedInputTokens" | "reasoningTokens"
const TOKENS: TokenMetric[] = ["inputTokens", "outputTokens", "cachedInputTokens", "reasoningTokens"]
const GAP_UPPERS = [0, ...Array.from({ length: 13 }, (_, i) => [1, 2, 5].map(n => n * 10 ** i)).flat(), Number.MAX_VALUE]

export interface BrowserPerformanceSnapshot {
  outcome: PerformanceMetricsGroup["outcome"]
  responses: number
  outputChunks: number
  metrics: Partial<Record<PerformanceMetricName, number>>
  gaps?: MetricDistribution
}

const object = (value: unknown): Record<string, unknown> => typeof value === "object" && value !== null ? value as Record<string, unknown> : {}
const number = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined

/** Browser-only observation. Kept with the local message, never uploaded as gateway telemetry. */
export class BrowserPerformance {
  private readonly startedAt: number
  private firstOutput?: number
  private firstText?: number
  private lastOutput?: number
  private chunks = 0
  private gaps?: MetricDistribution
  private protocol: OutputProtocol = "chat_completions"
  private messageInput: Partial<Record<"input_tokens" | "cache_read_input_tokens" | "cache_creation_input_tokens", number>> = {}
  private readonly responses: Array<Partial<Record<TokenMetric, number>>> = []
  private readonly completed: boolean[] = []
  private result?: BrowserPerformanceSnapshot
  private synthetic = false

  constructor(private readonly now: () => number = () => performance.now()) { this.startedAt = now() }

  beginResponse(protocol: OutputProtocol): void {
    this.protocol = protocol
    this.messageInput = {}
    this.responses.push({})
    this.completed.push(false)
  }

  unavailableStreamingTiming(): void { this.synthetic = true }

  observe = (event: unknown): void => {
    if (this.result) return
    const e = object(event)
    const choices = Array.isArray(e.choices) ? e.choices : []
    const candidates = Array.isArray(e.candidates) ? e.candidates : []
    const terminal = this.protocol === "chat_completions" ? event === "[DONE]" || choices.some(c => Boolean(object(c).finish_reason))
      : this.protocol === "messages" ? e.type === "message_stop"
      : this.protocol === "responses" ? e.type === "response.completed" || e.type === "response.incomplete"
      : candidates.some(c => Boolean(object(c).finishReason))
    if (terminal && this.completed.length) this.completed[this.completed.length - 1] = true
    this.readUsage(event)
    const { output, text } = classifyOutputEvent(this.protocol, event)
    if (!output) return
    const at = this.now()
    this.firstOutput ??= at
    if (text) this.firstText ??= at
    if (this.lastOutput !== undefined) {
      const gap = Math.max(0, at - this.lastOutput)
      const d = this.gaps ??= { count: 0, sum: 0, min: gap, max: gap, buckets: [] }
      d.count++
      d.sum += gap
      d.min = Math.min(d.min, gap)
      d.max = Math.max(d.max, gap)
      const upper = GAP_UPPERS.find(n => gap <= n) ?? Number.MAX_VALUE
      const bucket = d.buckets.find(b => b.upper === upper)
      if (bucket) bucket.count++
      else d.buckets.push({ upper, count: 1 })
    }
    this.lastOutput = at
    this.chunks++
  }

  private readUsage(event: unknown): void {
    const tokens = this.responses.at(-1)
    if (!tokens) return
    const e = object(event)
    const u = object(e.usage ?? object(e.response).usage ?? object(e.message).usage ?? e.usageMetadata)
    const set = (key: TokenMetric, value: unknown) => {
      const n = number(value)
      if (n !== undefined) tokens[key] = Math.max(tokens[key] ?? 0, n)
    }
    if (this.protocol === "messages") {
      // Messages usage updates can omit previously reported input/cache components.
      for (const key of ["input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"] as const) {
        const value = number(u[key])
        if (value !== undefined) this.messageInput[key] = Math.max(this.messageInput[key] ?? 0, value)
      }
      if (this.messageInput.input_tokens !== undefined) set("inputTokens", this.messageInput.input_tokens + (this.messageInput.cache_read_input_tokens ?? 0) + (this.messageInput.cache_creation_input_tokens ?? 0))
      set("cachedInputTokens", u.cache_read_input_tokens)
      // message_start.output_tokens = 0 is initialization, not measured completion usage.
      if (e.type === "message_delta") set("outputTokens", u.output_tokens)
    } else if (this.protocol === "gemini") {
      set("inputTokens", u.promptTokenCount)
      set("outputTokens", u.candidatesTokenCount)
      set("cachedInputTokens", u.cachedContentTokenCount)
      set("reasoningTokens", u.thoughtsTokenCount)
    } else {
      set("inputTokens", u.input_tokens ?? u.prompt_tokens)
      set("outputTokens", u.output_tokens ?? u.completion_tokens)
      set("cachedInputTokens", object(u.input_tokens_details ?? u.prompt_tokens_details).cached_tokens)
      set("reasoningTokens", object(u.output_tokens_details ?? u.completion_tokens_details).reasoning_tokens)
    }
  }

  finish(outcome: BrowserPerformanceSnapshot["outcome"]): BrowserPerformanceSnapshot {
    if (this.result) return this.result
    const totalMs = Math.max(0, this.now() - this.startedAt)
    const metrics: BrowserPerformanceSnapshot["metrics"] = { totalMs }
    for (const key of TOKENS) {
      if (this.responses.length && this.responses.every(r => r[key] !== undefined)) metrics[key] = this.responses.reduce((sum, r) => sum + (r[key] ?? 0), 0)
    }
    if (!this.synthetic && this.firstOutput !== undefined) metrics.ttftMs = this.firstOutput - this.startedAt
    if (!this.synthetic && this.firstText !== undefined) metrics.firstTextMs = this.firstText - this.startedAt
    if (!this.synthetic && this.firstOutput !== undefined && this.lastOutput !== undefined && this.chunks >= 2) {
      metrics.generationMs = this.lastOutput - this.firstOutput
    }
    if (totalMs > 0 && metrics.outputTokens !== undefined) metrics.overallTps = metrics.outputTokens * 1000 / totalMs
    if (!this.synthetic && this.gaps) metrics.maxGapMs = this.gaps.max
    const finalOutcome = outcome === "success" && this.completed.some(done => !done) ? "error" : outcome
    this.result = { outcome: finalOutcome, metrics, responses: this.responses.length, outputChunks: this.chunks, ...(!this.synthetic && this.gaps ? { gaps: structuredClone(this.gaps) } : {}) }
    return this.result
  }
}
