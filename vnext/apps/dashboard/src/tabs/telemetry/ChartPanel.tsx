import { useCallback, useId, useMemo } from "react"
import type { TelemetryDimFilter, TelemetryMetricInfo, TelemetrySeries, TelemetrySettings } from "../../api/telemetry"
import { TimeSeriesChart, paletteFor } from "../../components/TimeSeriesChart"
import { useT } from "../../state/i18n"
import { Card, SectionHeading } from "../../ui/card"
import { Notice } from "../../ui/notice"
import { SegmentedControl, type SegmentedOption } from "../../ui/segmented-control"
import { Select } from "../../ui/select"
import { CheckStrip, LatencyNote } from "./Panels"
import { chartFromSeries, filterText, formatValue, valueWithName, latencyCheckMetric, metricDescriptionKey, metricNameKey, windowTotal, type ChartRange } from "./telemetry-format"

export interface ChartPanelProps {
  metrics: TelemetryMetricInfo[]
  metric: string
  range: ChartRange
  /** The custom period (UTC dates, both included), used when `range` is "custom". */
  customStart?: string
  customEnd?: string
  /** Today's UTC date, the latest end date. */
  today?: string
  /** An already translated message when the custom period cannot be shown. */
  rangeError?: string
  /** The window being shown, e.g. "11-01 00:00 – 11-17 06:00 UTC", for the total line. */
  windowLabel?: string
  groupBy: string
  /** The dim the "Only" selector offers (null: the metric has fewer than two dims) and its values for the window (null while loading). */
  filterKey?: string | null
  filterValues?: readonly string[] | null
  /** The active filter, already known to match `filterKey`. */
  filter?: TelemetryDimFilter | null
  onFilter?: (value: string) => void
  series: TelemetrySeries | null
  /** When the series was fetched (ms): check hours are judged against this, not the render time. Defaults to now. */
  fetchedAt?: number
  settings: TelemetrySettings
  surgeHours: ReadonlySet<string>
  dark: boolean
  /** An already translated message. */
  error: string
  onMetric: (metric: string) => void
  onRange: (range: ChartRange) => void
  onCustom?: (start: string, end: string) => void
  onGroupBy: (groupBy: string) => void
}

export function ChartPanel(props: ChartPanelProps) {
  const t = useT()
  const titleId = useId()
  const { metrics, metric, series, settings } = props
  const isCheck = (settings.checkMetrics ?? []).includes(metric)
  const dims = metrics.find(info => info.metric === metric)?.dims ?? []
  const ranges: Array<SegmentedOption<ChartRange>> = [
    { value: "24h", label: t("dash.tlmRange24h") }, { value: "7d", label: t("dash.tlmRange7d") }, { value: "30d", label: t("dash.tlmRange30d") },
    { value: "custom", label: t("dash.tlmRangeCustom") },
  ]
  const startId = useId()
  const endId = useId()
  // Stable inputs keep the chart from being rebuilt (and its animation replayed) by unrelated re-renders.
  const { groupBy, dark, surgeHours } = props
  const chart = useMemo(() => series && !isCheck ? chartFromSeries({
    series, settings, groupBy, palette: paletteFor(dark ? "dark" : "light"), totalLabel: t("dash.tlmTotal"),
    otherLabel: t("dash.tlmOtherLabel"), noneLabel: t("dash.tlmNoGroup"), surgeHours,
  }) : null, [series, isCheck, settings, groupBy, dark, surgeHours, t])
  const unit = series?.unit ?? null
  const formatY = useCallback((value: number) => formatValue(value, unit), [unit])
  const unitName = (u: string | null | undefined) => u === "bytes" ? t("dash.tlmUnitBytes") : u === "count" ? t("dash.tlmUnitCount") : u === "ms" ? t("dash.tlmUnitMs") : ""
  const yTitle = unit === "bytes" ? t("dash.tlmAxisBytes") : unit === "count" ? t("dash.tlmAxisCount") : unit === "ms" ? t("dash.tlmAxisMs") : undefined
  return <Card aria-labelledby={titleId} className="space-y-3">
    <SectionHeading id={titleId}>{t("dash.tlmChart")}</SectionHeading>
    {props.error ? <Notice tone="danger">{props.error}</Notice> : null}
    {metrics.length === 0 ? (props.error ? null : <p className="text-body text-fg-subtle">{t("dash.tlmNoMetrics")}</p>) : <>
      <div className="flex flex-wrap items-center gap-2">
        <Select value={metric} ariaLabel={t("dash.tlmMetric")} size="sm" onChange={props.onMetric}
          options={metrics.map(info => {
            const about = metricDescriptionKey(info.metric)
            const named = metricNameKey(info.metric)
            const base = named ? `${info.metric} · ${t(named)}` : info.metric
            return { value: info.metric, label: unitName(info.unit) ? `${base} (${unitName(info.unit)})` : base, ...(about ? { description: t(about) } : {}) }
          })} />
        {isCheck ? null : <Select value={props.groupBy} ariaLabel={t("dash.tlmGroupBy")} size="sm" onChange={props.onGroupBy}
          options={[{ value: "", label: t("dash.tlmGroupNone") }, ...dims.map(dim => ({ value: dim, label: dim }))]} />}
        {isCheck || !props.filterKey ? null : <Select value={props.filter?.value ?? ""} ariaLabel={t("dash.tlmFilter")} size="sm" onChange={value => props.onFilter?.(value)}
          options={[{ value: "", label: t("dash.tlmFilterAll", { dim: props.filterKey }) },
            ...[...new Set([...(props.filterValues ?? []), ...(props.filter ? [props.filter.value] : [])])].map(value => ({ value, label: valueWithName(settings, props.filterKey!, value) }))]} />}
        <SegmentedControl options={ranges} value={props.range} onChange={props.onRange} ariaLabel={t("dash.tlmRangeLabel")} size="sm" />
        {props.range === "custom" ? <div className="flex flex-wrap items-center gap-2">
          <label htmlFor={startId} className="text-xs font-medium text-fg-muted">{t("dash.tlmStartDate")}</label>
          <input id={startId} type="date" value={props.customStart ?? ""} max={props.today} onChange={event => props.onCustom?.(event.target.value, props.customEnd ?? "")} />
          <label htmlFor={endId} className="text-xs font-medium text-fg-muted">{t("dash.tlmEndDate")}</label>
          <input id={endId} type="date" value={props.customEnd ?? ""} max={props.today} onChange={event => props.onCustom?.(props.customStart ?? "", event.target.value)} />
          <span className="text-xs text-fg-subtle">{t("dash.tlmUtcDates")}</span>
        </div> : null}
      </div>
      {props.rangeError ? <Notice tone="warn">{props.rangeError}</Notice> : null}
      {series !== null && !isCheck && !props.rangeError && windowTotal(series) !== null ? <p className="text-body text-fg-muted" data-testid="tlm-window-total">
        {props.filter ? t("dash.tlmWindowTotalFiltered", { range: props.windowLabel ?? "", filter: filterText(settings, props.filter) }) : t("dash.tlmWindowTotal", { range: props.windowLabel ?? "" })}: <b className="font-medium tabular-nums text-fg">{formatValue(windowTotal(series)!, series.unit)}</b>
      </p> : null}
      {metricDescriptionKey(metric) ? <p className="text-xs text-fg-muted">{t(metricDescriptionKey(metric)!)}</p> : null}
      <LatencyNote metric={metric} check={latencyCheckMetric(metric, settings.checkMetrics ?? [])} />
      {props.rangeError ? null : series === null ? (props.error ? null : <p className="text-body text-fg-subtle">{t("dash.loadingShort")}</p>)
        : isCheck ? <CheckStrip hours={series.hours} statuses={series.statuses ?? series.hours.map(() => "not monitored" as const)} stages={series.stages ?? []} nowMs={props.fetchedAt} />
        : chart ? <TimeSeriesChart labels={chart.labels} datasets={chart.datasets} height={280} yTickFormat={formatY} tooltipFormat={formatY} yTitle={yTitle} /> : null}
      {series !== null && (isCheck || chart) ? <p className="text-xs text-fg-subtle">{t("dash.tlmUtcNote")}</p> : null}
    </>}
  </Card>
}
