import { useCallback, useId, useMemo } from "react"
import type { TelemetryMetricInfo, TelemetrySeries, TelemetrySettings } from "../../api/telemetry"
import { TimeSeriesChart, paletteFor } from "../../components/TimeSeriesChart"
import { useT } from "../../state/i18n"
import { Card, SectionHeading } from "../../ui/card"
import { Notice } from "../../ui/notice"
import { SegmentedControl, type SegmentedOption } from "../../ui/segmented-control"
import { Select } from "../../ui/select"
import { CheckStrip, LatencyNote } from "./Panels"
import { chartFromSeries, formatValue, latencyCheckMetric, metricDescriptionKey, type RangeId } from "./telemetry-format"

export interface ChartPanelProps {
  metrics: TelemetryMetricInfo[]
  metric: string
  range: RangeId
  groupBy: string
  series: TelemetrySeries | null
  /** When the series was fetched (ms): check hours are judged against this, not the render time. Defaults to now. */
  fetchedAt?: number
  settings: TelemetrySettings
  surgeHours: ReadonlySet<string>
  dark: boolean
  /** An already translated message. */
  error: string
  onMetric: (metric: string) => void
  onRange: (range: RangeId) => void
  onGroupBy: (groupBy: string) => void
}

export function ChartPanel(props: ChartPanelProps) {
  const t = useT()
  const titleId = useId()
  const { metrics, metric, series, settings } = props
  const isCheck = (settings.checkMetrics ?? []).includes(metric)
  const dims = metrics.find(info => info.metric === metric)?.dims ?? []
  const ranges: Array<SegmentedOption<RangeId>> = [
    { value: "24h", label: t("dash.tlmRange24h") }, { value: "7d", label: t("dash.tlmRange7d") }, { value: "30d", label: t("dash.tlmRange30d") },
  ]
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
            return { value: info.metric, label: unitName(info.unit) ? `${info.metric} (${unitName(info.unit)})` : info.metric, ...(about ? { description: t(about) } : {}) }
          })} />
        {isCheck ? null : <Select value={props.groupBy} ariaLabel={t("dash.tlmGroupBy")} size="sm" onChange={props.onGroupBy}
          options={[{ value: "", label: t("dash.tlmGroupNone") }, ...dims.map(dim => ({ value: dim, label: dim }))]} />}
        <SegmentedControl options={ranges} value={props.range} onChange={props.onRange} ariaLabel={t("dash.tlmRangeLabel")} size="sm" />
      </div>
      {metricDescriptionKey(metric) ? <p className="text-xs text-fg-muted">{t(metricDescriptionKey(metric)!)}</p> : null}
      <LatencyNote metric={metric} check={latencyCheckMetric(metric, settings.checkMetrics ?? [])} />
      {series === null ? (props.error ? null : <p className="text-body text-fg-subtle">{t("dash.loadingShort")}</p>)
        : isCheck ? <CheckStrip hours={series.hours} statuses={series.statuses ?? series.hours.map(() => "not monitored" as const)} stages={series.stages ?? []} nowMs={props.fetchedAt} />
        : chart ? <TimeSeriesChart labels={chart.labels} datasets={chart.datasets} height={280} yTickFormat={formatY} tooltipFormat={formatY} yTitle={yTitle} /> : null}
      {series !== null && (isCheck || chart) ? <p className="text-xs text-fg-subtle">{t("dash.tlmUtcNote")}</p> : null}
    </>}
  </Card>
}
