import type { UsageRow } from "../api/usage"
import { rowMatchesUser, type ParticipantIndex } from "../tabs/usage/participants"

export const ALL_INCOMING_MODEL_OPTION = "all"
export const LEGACY_INCOMING_MODEL_OPTION = "legacy"
const INCOMING_MODEL_VALUE_PREFIX = "model:"

export function incomingModelOptionValue(model: string): string {
  return `${INCOMING_MODEL_VALUE_PREFIX}${model}`
}

export function incomingModelFilterValue(model: string | null): string {
  if (model === null) return ALL_INCOMING_MODEL_OPTION
  if (model === "") return LEGACY_INCOMING_MODEL_OPTION
  return incomingModelOptionValue(model)
}

export function decodeIncomingModelOption(value: string): string | null {
  if (value === ALL_INCOMING_MODEL_OPTION) return null
  if (value === LEGACY_INCOMING_MODEL_OPTION) return ""
  return value.startsWith(INCOMING_MODEL_VALUE_PREFIX)
    ? value.slice(INCOMING_MODEL_VALUE_PREFIX.length)
    : null
}

export function incomingModelSelectOptions(
  models: readonly string[],
  labels: { all: string; legacy: string },
): Array<{ value: string; label: string }> {
  return [
    { value: ALL_INCOMING_MODEL_OPTION, label: labels.all },
    { value: LEGACY_INCOMING_MODEL_OPTION, label: labels.legacy },
    ...[...new Set(models)].filter((model) => model !== "").sort().map((model) => ({ value: incomingModelOptionValue(model), label: model })),
  ]
}

export type UsageTranslator = (key: string, vars?: Record<string, string | number>) => string

export function formatUsageFilterHint(
  dimensions: { selected: string[]; remaining: string[] },
  t: UsageTranslator,
): string {
  if (dimensions.selected.length === 0) return t("dash.filterHintOverall")
  const selected = dimensions.selected.join(", ")
  if (dimensions.remaining.length === 0) return t("dash.filterHintFiltered", { selected })
  return t("dash.filterHintFilteredRemaining", {
    selected,
    remaining: dimensions.remaining.join(" & "),
  })
}

export interface UsageModelFilters {
  user: string
  key: string
  client: string
  model: string
  /** null is all incoming models; an empty string is a legacy record. */
  incomingModel: string | null
}

export interface ModelDistributionRow {
  /** Stable identity; can differ from label when a real model matches the legacy label. */
  id: string
  label: string
  requests: number
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
  costUSD: number
  routedModels?: string[]
}

export interface UsageSummaryValues {
  requests: number
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
  costUSD: number
}

export function buildDistribution(
  rows: UsageRow[],
  keyFor: (row: UsageRow) => string,
  labelFor: (row: UsageRow, key: string) => string,
): ModelDistributionRow[] {
  return distributeBy(rows, keyFor, labelFor, false)
}

export function filterUsageRows(
  rows: UsageRow[],
  filters: UsageModelFilters,
  participants: ParticipantIndex,
): UsageRow[] {
  return rows.filter((row) => {
    if (filters.key && row.keyId !== filters.key) return false
    if (filters.client && row.client !== filters.client) return false
    if (filters.model && row.model !== filters.model) return false
    if (filters.incomingModel !== null && row.incomingModel !== filters.incomingModel) return false
    return !filters.user || rowMatchesUser(participants, row.keyId, filters.user)
  })
}

function addRow(target: UsageSummaryValues, row: UsageRow | UsageSummaryValues): void {
  target.requests += row.requests
  if ("inputTokens" in row) {
    target.input += row.inputTokens
    target.output += row.outputTokens
    target.cacheRead += row.cacheReadTokens ?? 0
    target.cacheCreation += row.cacheCreationTokens ?? 0
    target.costUSD += row.cost?.totalUSD ?? 0
    return
  }
  target.input += row.input
  target.output += row.output
  target.cacheRead += row.cacheRead
  target.cacheCreation += row.cacheCreation
  target.costUSD += row.costUSD
}

export function summarizeUsageRows(rows: Array<UsageRow | UsageSummaryValues>): UsageSummaryValues {
  const summary: UsageSummaryValues = {
    requests: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreation: 0,
    costUSD: 0,
  }
  for (const row of rows) addRow(summary, row)
  return summary
}

function sortDistribution(rows: ModelDistributionRow[]): ModelDistributionRow[] {
  return rows.sort((a, b) => {
    const aTokens = a.input + a.output + a.cacheRead + a.cacheCreation
    const bTokens = b.input + b.output + b.cacheRead + b.cacheCreation
    return bTokens - aTokens || a.label.localeCompare(b.label)
  })
}

function distributeBy(
  rows: UsageRow[],
  keyFor: (row: UsageRow) => string,
  labelFor: (row: UsageRow, key: string) => string,
  includeRoutedModels: boolean,
  unknownRoutedModelLabel = "Unknown",
): ModelDistributionRow[] {
  const distribution = new Map<string, ModelDistributionRow>()
  const routed = new Map<string, Set<string>>()
  for (const row of rows) {
    const key = keyFor(row)
    let target = distribution.get(key)
    if (!target) {
      target = { id: key, label: labelFor(row, key), requests: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0, costUSD: 0 }
      distribution.set(key, target)
    }
    addRow(target, row)
    if (includeRoutedModels) {
      let models = routed.get(key)
      if (!models) {
        models = new Set()
        routed.set(key, models)
      }
      models.add(row.model || unknownRoutedModelLabel)
    }
  }
  for (const [key, target] of distribution) {
    const models = routed.get(key)
    if (models) target.routedModels = [...models].sort()
  }
  return sortDistribution([...distribution.values()])
}

export function buildRoutedModelDistribution(rows: UsageRow[], unknownLabel: string): ModelDistributionRow[] {
  return distributeBy(
    rows,
    (row) => row.model ? `model:${row.model}` : "missing:",
    (row) => row.model || unknownLabel,
    false,
  )
}

export function buildIncomingModelDistribution(
  rows: UsageRow[],
  legacyLabel: string,
  unknownRoutedModelLabel: string,
): ModelDistributionRow[] {
  return distributeBy(
    rows,
    (row) => row.incomingModel,
    (row, key) => key === "" ? legacyLabel : row.incomingModel,
    true,
    unknownRoutedModelLabel,
  )
}
