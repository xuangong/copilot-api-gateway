# Streaming performance metrics

User approved all proposed metrics and the full collection → storage → Dashboard / Models implementation on 2026-09-08.

## Semantics

- Preserve total request time. Record gateway first meaningful generated output (TTFT), first answer text, observed output-arrival span, actual upstream elapsed time, input/output/cached/reasoning token counts, upstream effective tokens/s, effective end-to-end tokens/s, meaningful output chunk gaps and maximum gap.
- Empty deltas, role/start/status/usage-only events, heartbeats and citations do not trigger first output. Nonempty reasoning and tool argument deltas trigger first output but not first text. Only answer text triggers first text.
- Native non-streaming responses and JSON transformed into synthetic streaming frames cannot provide streaming timing. Leave these metrics absent. Do not invent zero measurements.
- Use monotonic time. Capture request end before background persistence. Separate gateway request start from upstream dispatch. Preserve context through translation, retries, and hosted tool continuations. Measure gateway output after protocol translation, and upstream occupancy at actual provider calls. Never label gateway measurements as browser measurements.
- Browser Models messages store their own observed timing across the complete send including tool continuations. A known synthetic HTTP response is marked with `x-gateway-stream-timing: unavailable`; Models suppresses streaming timing for that send. A later internal tool leg can change upstream response mode after headers have been sent, so browser timings remain observations of received content, not a guarantee of native upstream generation cadence. Show browser observation explicitly. No client timings are uploaded as trusted backend statistics.
- Upstream effective throughput is reported output tokens divided by the complete elapsed time of all upstream calls for that request, including prefill, hidden reasoning and first-output wait, but excluding time between upstream calls (for example external tool execution). It is not model decode speed. Overall throughput divides the same usage by complete request/send elapsed time. Never divide total usage by output-arrival span: buffering and hidden reasoning make these intervals incomparable. Missing usage or zero elapsed time stays unknown.
- Browser Models has only its complete-send throughput, not trusted upstream timing or model decode speed. Legacy `outputTps` is retired: keep its rows for audit, exclude it from API/UI, and collect `upstreamTps` for new requests without reconstructing per-request rates from unpaired historical aggregates.
- Split success, error and cancellation. Compare actual model/upstream/source-target protocol/runtime, input-size band, cache hit/miss/unknown, reasoning effort, streaming mode. Preserve incoming model aliases separately from actual targets.
- Record sample count and histogram P50/P95. Histogram percentiles are upper-bound estimates. Gap distributions describe chunks, not true inter-token latency.
- Keep legacy aggregate tables compatible. Add numbered migration and new aggregated metrics tables; no unbounded per-request event storage. Mark legacy requests as uncollected for new fields. Correct /api/latency's fabricated upstream/TTFB values to null when unavailable.

## Shared API contract

Expose GET /api/performance/metrics?start=<UTC-hour>&end=<UTC-hour>, with identical admin/user/shared-view key scoping to existing /api/performance. Validate ranges. Response:

```ts
type PerformanceMetricName = 'totalMs' | 'upstreamMs' | 'ttftMs' | 'firstTextMs' | 'generationMs' | 'inputTokens' | 'outputTokens' | 'cachedInputTokens' | 'reasoningTokens' | 'upstreamTps' | 'overallTps' | 'gapMs' | 'maxGapMs'
interface MetricDistribution {
  count: number
  sum: number
  min: number
  max: number
  buckets: Array<{ upper: number; count: number }>
}
interface PerformanceMetricsGroup {
  keyId: string
  keyName?: string
  incomingModel: string
  model: string
  upstream: string | null
  sourceApi: string
  targetApi: string
  stream: boolean
  runtimeLocation: string
  outcome: 'success' | 'error' | 'cancelled'
  inputBucket: string
  cacheStatus: 'hit' | 'miss' | 'unknown'
  reasoningEffort: string
  requests: number
  metrics: Partial<Record<PerformanceMetricName, MetricDistribution>>
}
interface PerformanceMetricsResponse {
  version: 2
  groups: PerformanceMetricsGroup[]
  legacyRequests: number
}
```

These types are exported by @vibe-llm/protocols/common from performance-metrics.ts. Gap histograms contain individual nonempty output-chunk gaps; other distributions contain one measurement per request. Client merges counts/sums/histograms, never averages percentiles. A missing distribution renders “未采集”. Each metric's sample count remains visible.

## UI

Retain existing Dashboard shell, time ranges and timezone controls. Latency becomes a compact metric table with mean/P50/P95/sample count, filters for the comparison dimensions, and per-model/upstream summary. Default to successful streaming requests; show counts for errors/cancellations and legacy coverage. Explanatory text distinguishes upstream throughput, complete-request throughput and output-arrival timing, and gateway timing from browser timing. Models messages get expandable browser metric details alongside existing usage/time footer. Support Chinese/English and narrow screens with existing design tokens.

## Verification and delivery

Test clock-controlled protocol classification and completion/cancellation, real SQLite upgrade/write/aggregation, D1 migration atomicity/retry, endpoint authorization, multi-protocol stream/nonstream and translation/tool paths, UI aggregation/missing data and browser streaming. Run ci:local and browser verification. Deployment authorization from this session covers CFW plus local desktop-linux/orbstack and SSH Docker; apply migrations before code activation. Preserve the three outstanding min-token fix files and user-owned remote data. Do not commit/push without a new completion request.

## Rate correction evidence

Production Astra samples had 27–34 ms output-arrival spans after many seconds upstream. Total usage divided by those spans produced impossible-looking generation rates and selected only a few samples with nonzero spans. CFW performance.now also advances only with I/O, per https://developers.cloudflare.com/workers/runtime-apis/web-standards/. The correction removes that formula; it does not clamp high values or manufacture model decode measurements. Unit coverage fixes upstream elapsed/output at 12.5 seconds/980 tokens and varies arrival spans across 0, 1 and 34 ms: upstreamTps remains 78.4.
