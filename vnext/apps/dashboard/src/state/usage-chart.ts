// The Usage trend chart's lines: who or what each one stands for, and the
// value, cost and cache it carries per time bucket. Pure, so the rules can be
// tested without React or Chart.js.
import type { UsageRow } from "../api/usage"

/** What one line of the trend chart stands for. */
export type ChartGrouping = "user" | "model"
/** Which model a row counts under: the one served (routed) or the one asked for (incoming). */
export type ModelKind = "routed" | "incoming"

/** Lines a per-model chart shows when it first draws; the rest wait in the legend. */
export const DEFAULT_VISIBLE_MODELS = 6

/**
 * Per person until an admin picks one, then per model. A non-admin only ever
 * sees their own usage, so for them a person is always picked. Tokens of
 * different models do not add up to anything meaningful, which is why a
 * person's usage is split by model rather than summed.
 */
export function chartGrouping(isAdmin: boolean, userFilter: string): ChartGrouping {
  return isAdmin && !userFilter ? "user" : "model"
}

export interface UsageChartSeries {
  id: string
  label: string
  /** Plotted value per bucket: tokens (cache included) or requests. */
  data: number[]
  /** USD per bucket. */
  cost: number[]
  /** Cache tokens per bucket, already inside `data`; zero for the requests metric. */
  cache: number[]
  /** Starts hidden; its legend entry can show it. */
  hidden: boolean
}

export interface UsageChartInput {
  rows: readonly UsageRow[]
  /** The buckets the chart draws, in order. */
  bucketKeys: readonly string[]
  /** The bucket a row falls in, in the same key space as `bucketKeys`. */
  bucketOf: (row: UsageRow) => string
  grouping: ChartGrouping
  modelKind: ModelKind
  metric: "tokens" | "requests"
  /** Who a row is attributed to, for per-person lines. */
  person: (row: UsageRow) => { id: string; label: string }
  /** Label for a row with no model recorded. */
  unknownLabel: string
}

const rowCache = (row: UsageRow): number => (row.cacheReadTokens ?? 0) + (row.cacheCreationTokens ?? 0)

const rowValue = (row: UsageRow, metric: UsageChartInput["metric"]): number =>
  metric === "requests" ? row.requests ?? 0 : (row.inputTokens ?? 0) + (row.outputTokens ?? 0) + rowCache(row)

function modelOf(row: UsageRow, kind: ModelKind, unknownLabel: string): { id: string; label: string } {
  const model = kind === "incoming" ? row.incomingModel : row.model
  return model ? { id: `model:${model}`, label: model } : { id: "missing:", label: unknownLabel }
}

export function buildUsageChartSeries(input: UsageChartInput): UsageChartSeries[] {
  const position = new Map(input.bucketKeys.map((key, i) => [key, i]))
  const width = input.bucketKeys.length
  const lines = new Map<string, UsageChartSeries & { total: number }>()
  for (const row of input.rows) {
    const at = position.get(input.bucketOf(row))
    if (at === undefined) continue
    const who = input.grouping === "user" ? input.person(row) : modelOf(row, input.modelKind, input.unknownLabel)
    let line = lines.get(who.id)
    if (!line) {
      line = {
        id: who.id,
        label: who.label,
        data: new Array<number>(width).fill(0),
        cost: new Array<number>(width).fill(0),
        cache: new Array<number>(width).fill(0),
        hidden: false,
        total: 0,
      }
      lines.set(who.id, line)
    }
    const value = rowValue(row, input.metric)
    line.data[at] = (line.data[at] ?? 0) + value
    line.cost[at] = (line.cost[at] ?? 0) + (typeof row.cost?.totalUSD === "number" ? row.cost.totalUSD : 0)
    if (input.metric === "tokens") line.cache[at] = (line.cache[at] ?? 0) + rowCache(row)
    line.total += value
  }
  const ordered = [...lines.values()]
  // People keep the order they first appear in, as the chart always drew them.
  if (input.grouping === "model") {
    ordered.sort((a, b) => b.total - a.total || a.label.localeCompare(b.label))
    ordered.forEach((line, i) => { line.hidden = i >= DEFAULT_VISIBLE_MODELS })
  }
  return ordered.map(({ total: _total, ...line }) => line)
}
