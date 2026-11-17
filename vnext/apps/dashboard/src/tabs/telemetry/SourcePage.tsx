import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  deleteTelemetrySource, rotateTelemetryKey, telemetryMetrics, telemetrySeries, telemetrySummary, telemetryTop, updateTelemetrySource,
  type TelemetryMetricInfo, type TelemetrySeries, type TelemetrySource, type TelemetrySummary, type TelemetryTop, type TelemetryUnit,
} from "../../api/telemetry"
import { useConfirm } from "../../state/confirm"
import { useT } from "../../state/i18n"
import { Button } from "../../ui/button"
import { Notice } from "../../ui/notice"
import { PageHeader } from "../../ui/page-header"
import { AvailabilityPanel } from "./AvailabilityPanel"
import { ChartPanel } from "./ChartPanel"
import { BudgetPanel, FlaggedPanel, FreshnessPanel, TopPanel } from "./Panels"
import { SettingsPanel } from "./SettingsPanel"
import { IssuedKeyPanel, type CopyTarget, type IssuedKeyView } from "./SourceList"
import { telemetryErrorKey } from "./telemetry-errors"
import { availabilityGroups, customWindow, defaultCustomDates, defaultMetric, hourShort, isAvailabilityMetric, rangeWindow, utcDate, type ChartRange, type RangeId } from "./telemetry-format"
import { loadAvailability, loadSeries, type AvailabilitySeries } from "./telemetry-series"
import { startPolling } from "./telemetry-sources"
import { editLimit, formToSettings, limitState, reconcileLimit, settingsToForm, shouldResetForm, type FormSource, type SettingsForm, type TextField } from "./telemetry-settings-form"

export function SourcePage({ source, onBack, onSourceChanged, onDeleted }: {
  source: TelemetrySource
  onBack: () => void
  onSourceChanged: (source: TelemetrySource) => void
  onDeleted: () => void
}) {
  const t = useT()
  const confirm = useConfirm()
  const [summary, setSummary] = useState<TelemetrySummary | null>(null)
  const [metrics, setMetrics] = useState<TelemetryMetricInfo[]>([])
  const [metric, setMetric] = useState("")
  const [range, setRange] = useState<ChartRange>("24h")
  const [custom, setCustom] = useState(() => defaultCustomDates(Date.now()))
  const [groupBy, setGroupBy] = useState("")
  const [series, setSeries] = useState<TelemetrySeries | null>(null)
  const [fetchedAt, setFetchedAt] = useState(() => Date.now())
  const [metricsLoaded, setMetricsLoaded] = useState(false)
  const [top, setTop] = useState<TelemetryTop | null>(null)
  const [summaryError, setSummaryError] = useState("")
  const [seriesError, setSeriesError] = useState("")
  const [topFailed, setTopFailed] = useState(false)
  const [tick, setTick] = useState(0)
  const [pollTick, setPollTick] = useState(0)
  const [availRange, setAvailRange] = useState<RangeId>("24h")
  const [availability, setAvailability] = useState<AvailabilitySeries[] | null>(null)
  const [availFetchedAt, setAvailFetchedAt] = useState(() => Date.now())
  const [availError, setAvailError] = useState("")

  const [form, setForm] = useState<SettingsForm>(() => settingsToForm(source.settings, null))
  const [name, setName] = useState(source.name)
  const [invalidField, setInvalidField] = useState<TextField | null>(null)
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)
  const [settingsError, setSettingsError] = useState("")
  const [issued, setIssued] = useState<IssuedKeyView | null>(null)
  const [copied, setCopied] = useState<CopyTarget | null>(null)

  // The unit of the budget metric typed in the form (stored one by default); the limit text is read in it.
  const metricUnit: TelemetryUnit | null = metrics.find(info => info.metric === form.budgetMetric.trim())?.unit ?? null
  const storedUnit: TelemetryUnit | null = metrics.find(info => info.metric === source.settings.budgetMetric)?.unit ?? null
  const limit = limitState(form, metricUnit, metricsLoaded)

  // Unsaved edits survive a rename and the metrics finishing their load; see shouldResetForm.
  const limitEdited = useRef(false)
  const formSource = useRef<FormSource>({ id: source.id, settings: JSON.stringify(source.settings) })
  useEffect(() => {
    const next: FormSource = { id: source.id, settings: JSON.stringify(source.settings) }
    if (shouldResetForm(formSource.current, next)) { setForm(settingsToForm(source.settings, storedUnit)); limitEdited.current = false }
    formSource.current = next
  }, [source.id, source.settings, storedUnit])
  // Once the unit is known the limit is rewritten from the stored value, unless it was edited; other edits are untouched.
  useEffect(() => {
    if (metricsLoaded) setForm(current => reconcileLimit(current, source.settings, metricUnit, limitEdited.current))
  }, [metricsLoaded, metricUnit, source.settings, form.limitUnit])
  useEffect(() => { setName(source.name) }, [source.id, source.name])

  // The summary (freshness, checks, flags) is refreshed every five minutes while the page is open and visible; the metric list is not polled.
  useEffect(() => startPolling(() => setPollTick(value => value + 1)), [])

  // Every summary request takes a number; only the latest request's answer is shown, so a slow older answer never overwrites a newer one.
  const summarySeq = useRef(0)
  const sourceIdRef = useRef(source.id)
  sourceIdRef.current = source.id
  const tRef = useRef(t)
  tRef.current = t

  useEffect(() => {
    let live = true
    const seq = ++summarySeq.current
    Promise.all([telemetrySummary(source.id), telemetryMetrics(source.id)]).then(([nextSummary, nextMetrics]) => {
      if (!live) return
      if (seq === summarySeq.current) setSummary(nextSummary)
      setMetrics(nextMetrics.metrics)
      setMetricsLoaded(true)
      const checks = source.settings.checkMetrics ?? []
      setMetric(current => nextMetrics.metrics.some(info => info.metric === current) && !isAvailabilityMetric(current, checks) ? current : defaultMetric(nextMetrics.metrics, source.settings))
      setSummaryError("")
    }).catch(() => { if (live && seq === summarySeq.current) setSummaryError(t("dash.tlmLoadError")) })
    return () => { live = false }
  }, [source.id, source.settings, tick, t])

  // A poll tick refreshes the summary only. It depends on the tick alone: a source switch, language change or settings save has its own load above.
  useEffect(() => {
    if (pollTick === 0) return
    const seq = ++summarySeq.current
    telemetrySummary(sourceIdRef.current).then(next => {
      if (seq === summarySeq.current) { setSummary(next); setSummaryError("") }
    }).catch(() => { if (seq === summarySeq.current) setSummaryError(tRef.current("dash.tlmLoadError")) })
  }, [pollTick])

  useEffect(() => {
    if (metric === "") return
    let live = true
    const started = Date.now()
    const chosen = range === "custom" ? customWindow(custom.start, custom.end, started) : rangeWindow(range, started)
    setSeries(null)
    setTop(null)
    setTopFailed(false)
    if ("error" in chosen) return
    const span = chosen
    loadSeries(telemetrySeries, source.id, { metric, ...span, groupBy, checkMetrics: source.settings.checkMetrics ?? [] })
      .then(next => { if (live) { setSeries(next); setFetchedAt(started); setSeriesError("") } }).catch(() => { if (live) setSeriesError(t("dash.tlmLoadError")) })
    if (groupBy !== "") {
      telemetryTop(source.id, { metric, ...span, groupBy, limit: 20 })
        .then(next => { if (live) setTop(next) }).catch(() => { if (live) setTopFailed(true) })
    }
    return () => { live = false }
  }, [source.id, source.settings.checkMetrics, metric, range, custom, groupBy, tick, t])

  // Availability checks have their own panel and range; the traffic chart lists every other metric.
  const checkMetrics = source.settings.checkMetrics
  const groups = useMemo(() => availabilityGroups(metrics, checkMetrics ?? []), [metrics, checkMetrics])
  const trafficMetrics = useMemo(() => metrics.filter(info => !isAvailabilityMetric(info.metric, checkMetrics ?? [])), [metrics, checkMetrics])
  useEffect(() => {
    if (groups.length === 0) { setAvailability(null); return }
    let live = true
    const started = Date.now()
    setAvailability(null)
    loadAvailability(telemetrySeries, source.id, groups, rangeWindow(availRange, started))
      .then(next => { if (live) { setAvailability(next); setAvailFetchedAt(started); setAvailError("") } })
      .catch(() => { if (live) setAvailError(t("dash.tlmLoadError")) })
    return () => { live = false }
  }, [source.id, groups, availRange, tick, t])

  // The custom period's problem, if any, and the label of the window the traffic chart shows.
  const rangeWindowNow = range === "custom" ? customWindow(custom.start, custom.end, fetchedAt) : rangeWindow(range, fetchedAt)
  const rangeError = "error" in rangeWindowNow ? t(rangeWindowNow.error === "too_long" ? "dash.tlmRangeTooLong" : rangeWindowNow.error === "order" ? "dash.tlmRangeOrder" : "dash.tlmRangeInvalid") : ""
  const windowLabel = "error" in rangeWindowNow ? "" : `${hourShort(rangeWindowNow.from)} – ${hourShort(rangeWindowNow.to)} UTC`

  // A dim that the newly chosen metric lacks cannot stay selected.
  const dims = useMemo(() => metrics.find(info => info.metric === metric)?.dims ?? [], [metrics, metric])
  useEffect(() => { if (groupBy !== "" && !dims.includes(groupBy)) setGroupBy("") }, [dims, groupBy])

  const units = useMemo(() => Object.fromEntries(metrics.map(info => [info.metric, info.unit])) as Record<string, TelemetryUnit>, [metrics])
  const surgeHours = useMemo(() => new Set((summary?.surges ?? []).filter(surge => surge.metric === metric).map(surge => surge.hour)), [summary, metric])
  const dark = typeof document !== "undefined" && document.documentElement.getAttribute("data-theme") !== "light"

  const save = async () => {
    // The limit is read in the unit its text is written in (decimal GB for bytes); it cannot be saved before that unit is known.
    if (limit === "loading" || limit === "mismatch") return
    const result = formToSettings(form)
    if (!result.ok) { setInvalidField(result.field); setSettingsError(t("dash.tlmSettingsInvalid")); setSaved(false); return }
    setBusy(true); setInvalidField(null); setSettingsError(""); setSaved(false)
    try {
      onSourceChanged((await updateTelemetrySource(source.id, { settings: result.settings })).source)
      limitEdited.current = false
      setSaved(true)
      setTick(value => value + 1)
    } catch (failure) { setSettingsError(t(telemetryErrorKey(failure))) }
    finally { setBusy(false) }
  }
  const rename = async () => {
    setBusy(true); setSettingsError("")
    try { onSourceChanged((await updateTelemetrySource(source.id, { name: name.trim() })).source) }
    catch (failure) { setSettingsError(t(telemetryErrorKey(failure))) }
    finally { setBusy(false) }
  }
  const rotate = async () => {
    const sure = await confirm({ title: t("dash.tlmRotateConfirmTitle", { name: source.name }), description: t("dash.tlmRotateConfirmHint"), confirmLabel: t("dash.tlmRotate"), danger: true })
    if (!sure) return
    setBusy(true); setSettingsError(""); setCopied(null)
    try {
      const result = await rotateTelemetryKey(source.id)
      setIssued({ sourceName: source.name, key: result.key, install: result.install })
    } catch (failure) { setSettingsError(t(telemetryErrorKey(failure))) }
    finally { setBusy(false) }
  }
  const remove = async () => {
    const sure = await confirm({ title: t("dash.tlmDeleteConfirmTitle", { name: source.name }), description: t("dash.tlmDeleteConfirmHint"), confirmLabel: t("dash.delete"), danger: true })
    if (!sure) return
    setBusy(true); setSettingsError("")
    try { await deleteTelemetrySource(source.id); onDeleted() }
    catch (failure) { setSettingsError(t(telemetryErrorKey(failure))); setBusy(false) }
  }
  const refresh = useCallback(() => setTick(value => value + 1), [])

  return <div className="space-y-4">
    <PageHeader title={source.name} description={t("dash.telemetryDescription")} actions={<>
      <Button variant="secondary" size="sm" onClick={refresh}>{t("dash.tlmRefresh")}</Button>
      <Button variant="ghost" size="sm" onClick={onBack}>{t("dash.tlmBack")}</Button>
    </>} />
    {summaryError ? <Notice tone="danger">{summaryError}</Notice> : null}
    <FreshnessPanel summary={summary} failed={summaryError !== ""} />
    <BudgetPanel budget={summary?.budget ?? null} />
    {groups.length > 0 ? <AvailabilityPanel data={availability} range={availRange} fetchedAt={availFetchedAt} dark={dark} error={availError} onRange={setAvailRange} /> : null}
    <ChartPanel metrics={trafficMetrics} metric={metric} range={range} customStart={custom.start} customEnd={custom.end} today={utcDate(Date.now())}
      rangeError={rangeError} windowLabel={windowLabel} onCustom={(start, end) => setCustom({ start, end })} groupBy={groupBy} series={series} fetchedAt={fetchedAt} settings={source.settings} surgeHours={surgeHours} dark={dark}
      error={seriesError} onMetric={setMetric} onRange={setRange} onGroupBy={setGroupBy} />
    <TopPanel top={top} settings={source.settings} groupBy={groupBy} failed={topFailed} />
    <FlaggedPanel summary={summary} settings={source.settings} units={units} failed={summaryError !== ""} />
    {issued ? <IssuedKeyPanel issued={issued} copied={copied} onDismiss={() => { setIssued(null); setCopied(null) }}
      onCopy={async what => {
        try { await navigator.clipboard.writeText(what === "install" ? issued.install : issued.key); setCopied(what) }
        catch { setSettingsError(t("dash.tlmCopyError")) }
      }} /> : null}
    <SettingsPanel form={form} name={name} busy={busy} error={settingsError} saved={saved} invalidField={invalidField} limitState={limit}
      onField={(field, value) => { if (field === "monthlyLimit") { limitEdited.current = true; setForm(current => editLimit(current, value, metricUnit)) } else setForm(current => ({ ...current, [field]: value })); setSaved(false) }} onName={setName}
      onSave={() => void save()} onRename={() => void rename()} onRotate={() => void rotate()} onDelete={() => void remove()} />
  </div>
}
