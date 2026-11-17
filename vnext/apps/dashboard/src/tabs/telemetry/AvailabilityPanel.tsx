import { useCallback, useId, useMemo } from "react"
import { TimeSeriesChart, paletteFor } from "../../components/TimeSeriesChart"
import { useT } from "../../state/i18n"
import { Card, SectionHeading } from "../../ui/card"
import { Notice } from "../../ui/notice"
import { SegmentedControl, type SegmentedOption } from "../../ui/segmented-control"
import { CheckStrip } from "./Panels"
import { zoneLabel, chartFromSeries, formatValue, type RangeId } from "./telemetry-format"
import type { AvailabilitySeries } from "./telemetry-series"

export interface AvailabilityPanelProps {
  /** One entry per configured check metric with data; null while loading. */
  data: AvailabilitySeries[] | null
  range: RangeId
  /** When the data was fetched (ms): check hours are judged against this. */
  fetchedAt?: number
  dark: boolean
  /** An already translated message. */
  error: string
  onRange: (range: RangeId) => void
}

/** Availability checks, apart from traffic: one marker per hour (a single check, never a percentage) and latency for passed hours. */
export function AvailabilityPanel(props: AvailabilityPanelProps) {
  const t = useT()
  const titleId = useId()
  const ranges: Array<SegmentedOption<RangeId>> = [
    { value: "24h", label: t("dash.tlmRange24h") }, { value: "7d", label: t("dash.tlmRange7d") }, { value: "30d", label: t("dash.tlmRange30d") },
  ]
  const formatMs = useCallback((value: number) => formatValue(value, "ms"), [])
  const { data, dark } = props
  const charts = useMemo(() => (data ?? []).map(entry => entry.latency ? chartFromSeries({
    series: entry.latency, settings: {}, groupBy: "", palette: paletteFor(dark ? "dark" : "light"), totalLabel: entry.latency.metric,
    otherLabel: "", noneLabel: "", surgeHours: new Set(),
  }) : null), [data, dark])
  return <Card aria-labelledby={titleId} className="space-y-3">
    <SectionHeading id={titleId}>{t("dash.tlmAvailability")}</SectionHeading>
    <p className="text-xs text-fg-subtle">{t("dash.tlmAvailabilityHint")}</p>
    {props.error ? <Notice tone="danger">{props.error}</Notice> : null}
    <SegmentedControl options={ranges} value={props.range} onChange={props.onRange} ariaLabel={t("dash.tlmRangeLabel")} size="sm" />
    {data === null ? (props.error ? null : <p className="text-body text-fg-subtle">{t("dash.loadingShort")}</p>) : data.map((entry, index) => {
      const chart = charts[index]
      return <div key={entry.check} className="space-y-2">
        <p className="text-xs font-medium text-fg-muted">{entry.check}</p>
        <CheckStrip hours={entry.checkSeries.hours} statuses={entry.checkSeries.statuses ?? entry.checkSeries.hours.map(() => "not monitored" as const)}
          stages={entry.checkSeries.stages ?? []} nowMs={props.fetchedAt} />
        {chart && entry.latency ? <>
          <p className="text-xs font-medium text-fg-muted">{entry.latency.metric}</p>
          <TimeSeriesChart labels={chart.labels} datasets={chart.datasets} height={180} yTickFormat={formatMs} tooltipFormat={formatMs} yTitle={t("dash.tlmAxisMs")} />
          <p className="text-xs text-fg-subtle">{t("dash.tlmLatencyPassedOnly")}</p>
        </> : null}
      </div>
    })}
    {data !== null && data.length > 0 ? <p className="text-xs text-fg-subtle">{t("dash.tlmZoneNote", { zone: zoneLabel(Date.now()) })}</p> : null}
  </Card>
}
