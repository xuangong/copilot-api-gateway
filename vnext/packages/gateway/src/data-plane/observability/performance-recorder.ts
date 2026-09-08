import { classifyOutputEvent, type MetricDistribution, type OutputProtocol, type PerformanceMetricName, type PerformanceMetricsGroup } from "@vibe-llm/protocols/common"

type TokenMetric = "inputTokens" | "outputTokens" | "cachedInputTokens" | "reasoningTokens"
type Outcome = PerformanceMetricsGroup["outcome"]
const TOKEN_METRICS: TokenMetric[] = ["inputTokens", "outputTokens", "cachedInputTokens", "reasoningTokens"]
const UPPERS = [0, ...Array.from({ length: 13 }, (_, i) => [1, 2, 5].map(n => n * 10 ** i)).flat(), Number.MAX_VALUE]

export function addMeasurement(metrics: Partial<Record<PerformanceMetricName, MetricDistribution>>, name: PerformanceMetricName, value: number): void {
  if (!Number.isFinite(value) || value < 0) return
  const upper = UPPERS.find(n => value <= n) ?? Number.MAX_VALUE
  const d = metrics[name] ??= { count: 0, sum: 0, min: value, max: value, buckets: [] }
  d.count++
  d.sum += value
  d.min = Math.min(d.min, value)
  d.max = Math.max(d.max, value)
  const b = d.buckets.find(bucket => bucket.upper === upper)
  if (b) b.count++
  else d.buckets.push({ upper, count: 1 })
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {}
}
function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

export class UpstreamObservation {
  readonly tokens: Partial<Record<TokenMetric, number>> = {}
  private readonly messageInput: Partial<Record<"input_tokens" | "cache_read_input_tokens" | "cache_creation_input_tokens", number>> = {}
  private endedAt?: number
  private terminal = false
  failed = false
  constructor(readonly protocol: OutputProtocol, private readonly recorder: PerformanceRecorder, readonly startedAt: number) {}

  finish(): void { this.endedAt ??= this.recorder.now() }
  elapsed(end: number): number { return Math.max(0, (this.endedAt ?? end) - this.startedAt) }
  json(body: unknown): void {
    this.terminal = true
    this.recorder.synthetic = true
    this.readUsage(body, true)
  }
  observe(event: unknown): void {
    const e = object(event)
    if (e.type === "message_stop" || e.type === "response.completed" || e.type === "response.incomplete") this.terminal = true
    if (e.type === "error" || e.type === "response.failed" || e.error !== undefined) { this.terminal = true; this.failed = true }
    this.readUsage(event, false)
  }
  done(): void { this.terminal = true }
  endFrames(): void { if (!this.terminal) this.failed = true }

  private readUsage(event: unknown, json: boolean): void {
    const e = object(event)
    const usage = object(e.usage ?? object(e.response).usage ?? object(e.message).usage ?? e.usageMetadata)
    const set = (key: TokenMetric, value: unknown): void => {
      const n = number(value)
      if (n !== undefined) this.tokens[key] = Math.max(this.tokens[key] ?? 0, n)
    }
    if (this.protocol === "messages") {
      // Messages reports disjoint cumulative components and may omit unchanged
      // cache fields from later usage events. Preserve each before summing.
      for (const field of ["input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"] as const) {
        const value = number(usage[field])
        if (value !== undefined) this.messageInput[field] = Math.max(this.messageInput[field] ?? 0, value)
      }
      set("cachedInputTokens", this.messageInput.cache_read_input_tokens)
      // message_start commonly invents output_tokens: 0. It is not final usage.
      if (json || e.type === "message_delta") set("outputTokens", usage.output_tokens)
      if (this.messageInput.input_tokens !== undefined) {
        this.tokens.inputTokens = this.messageInput.input_tokens + (this.messageInput.cache_read_input_tokens ?? 0) + (this.messageInput.cache_creation_input_tokens ?? 0)
      }
    } else if (this.protocol === "gemini") {
      set("inputTokens", usage.promptTokenCount)
      set("outputTokens", usage.candidatesTokenCount)
      set("cachedInputTokens", usage.cachedContentTokenCount)
      set("reasoningTokens", usage.thoughtsTokenCount)
    } else {
      set("inputTokens", usage.input_tokens ?? usage.prompt_tokens)
      set("outputTokens", usage.output_tokens ?? usage.completion_tokens)
      set("cachedInputTokens", object(usage.input_tokens_details ?? usage.prompt_tokens_details).cached_tokens)
      set("reasoningTokens", object(usage.output_tokens_details ?? usage.completion_tokens_details).reasoning_tokens)
    }
  }
}

export class PerformanceRecorder {
  readonly startedAt: number
  readonly hour = new Date().toISOString().slice(0, 13)
  synthetic = false
  reasoningEffort = "unknown"
  private firstOutput?: number
  private firstText?: number
  private lastOutput?: number
  private outputChunks = 0
  private finishedAt?: number
  private outcome: Outcome = "success"
  private failed = false
  private unbindCancellation?: () => void
  private metricsRecorded = false
  private legacyRecorded = false
  private readonly upstreams: UpstreamObservation[] = []
  private readonly gaps: Partial<Record<PerformanceMetricName, MetricDistribution>> = {}
  constructor(public streaming: boolean, readonly now: () => number = () => performance.now(), startedAt?: number) { this.startedAt = startedAt ?? now() }

  bindCancellation(signal: AbortSignal): void {
    const cancel = (): void => this.finish("cancelled")
    if (signal.aborted) cancel()
    else {
      signal.addEventListener("abort", cancel, { once: true })
      this.unbindCancellation = () => signal.removeEventListener("abort", cancel)
    }
  }

  beginUpstream(protocol: OutputProtocol, payload: unknown): UpstreamObservation {
    const p = object(payload)
    const effort = p.reasoning_effort ?? object(p.reasoning).effort ?? object(p.output_config).effort
    if (typeof effort === "string") this.reasoningEffort = effort.slice(0, 64)
    const observation = new UpstreamObservation(protocol, this, this.now())
    this.upstreams.push(observation)
    return observation
  }

  observeOutput(protocol: OutputProtocol, event: unknown): void {
    if (this.finishedAt !== undefined) return
    const e = object(event)
    if (e.type === "error" || e.type === "response.failed" || e.error !== undefined) this.failed = true
    if (!this.streaming || this.synthetic) return
    const { output, text } = classifyOutputEvent(protocol, event)
    if (!output) return
    const now = this.now()
    this.firstOutput ??= now
    if (text) this.firstText ??= now
    if (this.lastOutput !== undefined) addMeasurement(this.gaps, "gapMs", now - this.lastOutput)
    this.lastOutput = now
    this.outputChunks++
  }

  finish(outcome: Outcome): void {
    if (this.finishedAt !== undefined) return
    this.finishedAt = this.now()
    this.unbindCancellation?.()
    this.outcome = outcome === "success" && (this.failed || this.upstreams.at(-1)?.failed) ? "error" : outcome
  }

  claimMetrics(): boolean { if (this.metricsRecorded) return false; this.metricsRecorded = true; return true }
  claimLegacy(): boolean { if (this.legacyRecorded) return false; this.legacyRecorded = true; return true }

  snapshot(): Pick<PerformanceMetricsGroup, "metrics" | "outcome" | "inputBucket" | "cacheStatus" | "reasoningEffort"> {
    const end = this.finishedAt ?? this.now()
    const total = Math.max(0, end - this.startedAt)
    const metrics: Partial<Record<PerformanceMetricName, MetricDistribution>> = {}
    addMeasurement(metrics, "totalMs", total)
    const upstreamMs = this.upstreams.reduce((sum, u) => sum + u.elapsed(end), 0)
    if (this.upstreams.length > 0) addMeasurement(metrics, "upstreamMs", upstreamMs)
    const tokens: Partial<Record<TokenMetric, number>> = {}
    for (const name of TOKEN_METRICS) {
      if (this.upstreams.length && this.upstreams.every(u => u.tokens[name] !== undefined)) {
        const value = this.upstreams.reduce((sum, u) => sum + (u.tokens[name] ?? 0), 0)
        tokens[name] = value
        addMeasurement(metrics, name, value)
      }
    }
    if (tokens.outputTokens !== undefined && total > 0) addMeasurement(metrics, "overallTps", tokens.outputTokens * 1000 / total)
    // Usage includes hidden reasoning and buffered output. Match it to the full
    // upstream interval; output-arrival spans cannot measure model decoding.
    if (tokens.outputTokens !== undefined && upstreamMs > 0) addMeasurement(metrics, "upstreamTps", tokens.outputTokens * 1000 / upstreamMs)
    if (this.streaming && !this.synthetic) {
      if (this.firstOutput !== undefined) addMeasurement(metrics, "ttftMs", this.firstOutput - this.startedAt)
      if (this.firstText !== undefined) addMeasurement(metrics, "firstTextMs", this.firstText - this.startedAt)
      if (this.outputChunks >= 2 && this.firstOutput !== undefined && this.lastOutput !== undefined) {
        const generationMs = this.lastOutput - this.firstOutput
        addMeasurement(metrics, "generationMs", generationMs)
        const gap = this.gaps.gapMs
        if (gap) {
          metrics.gapMs = structuredClone(gap)
          addMeasurement(metrics, "maxGapMs", gap.max)
        }
      }
    }
    const input = tokens.inputTokens
    return {
      metrics, outcome: this.outcome, reasoningEffort: this.reasoningEffort,
      inputBucket: input === undefined ? "unknown" : input < 1000 ? "<1k" : input < 8000 ? "1k-8k" : input < 32000 ? "8k-32k" : input < 128000 ? "32k-128k" : ">=128k",
      cacheStatus: tokens.cachedInputTokens === undefined ? "unknown" : tokens.cachedInputTokens > 0 ? "hit" : "miss",
    }
  }
}
