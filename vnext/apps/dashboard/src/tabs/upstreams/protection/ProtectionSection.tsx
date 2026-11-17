import { useId, useMemo, useState } from "react"
import { bannerItems } from "../../../components/protection-banner-model"
import type { ErrorClassKey, ProtectionSettings } from "../../../api/protection"
import type { UpstreamRecord } from "../../../api/types"
import { patchUpstream } from "../../../api/upstreams"
import { useT } from "../../../state/i18n"
import { useProtection } from "../../../state/protection"
import { useToast } from "../../../state/toast"
import { Button } from "../../../ui/button"
import { SectionHeading } from "../../../ui/card"
import { Notice } from "../../../ui/notice"
import { SegmentedControl, type SegmentedOption } from "../../../ui/segmented-control"
import { zoneLabel } from "../../telemetry/telemetry-format"
import { ErrorBarChart } from "./ErrorBarChart"
import { ProtectionStates } from "./ProtectionStates"
import { ErrorSamplesTable } from "./ErrorSamplesTable"
import { PauseHistoryTable } from "./PauseHistoryTable"
import { ProtectionSettingsForm } from "./ProtectionSettingsForm"
import { chartTotals, errorChartModel, type ErrorRange } from "./error-chart"
import { PROTECTION_DEFAULTS, saveFailure, type FieldErrors } from "./protection-form"
import { useProtectionData } from "./use-protection-data"

type Translate = (key: string, vars?: Record<string, string | number>) => string
const classLabel = (t: Translate, key: ErrorClassKey): string => {
  switch (key) {
    case "rate_limited": return t("dash.protClassRateLimited")
    case "rejected": return t("dash.protClassRejected")
    case "auth": return t("dash.protClassAuth")
    case "upstream": return t("dash.protClassUpstream")
    case "network": return t("dash.protClassNetwork")
    case "other": return t("dash.protClassOther")
  }
}

/** Per-upstream protection: current state, settings, the error chart, samples and history. Mounted only while open. */
export function ProtectionSection({ upstream, onSaved }: { upstream: UpstreamRecord; onSaved: () => void }) {
  const t = useT()
  const { push: toast } = useToast()
  const store = useProtection()
  const [range, setRange] = useState<ErrorRange>("24h")
  const [reloadTick, setReloadTick] = useState(0)
  const [saving, setSaving] = useState(false)
  const [serverErrors, setServerErrors] = useState<FieldErrors>({})
  const headingId = useId()
  const data = useProtectionData(upstream.id, range, reloadTick)
  const saved: ProtectionSettings = useMemo(() => upstream.protection ?? PROTECTION_DEFAULTS, [upstream.protection])

  // Memoised so the chart is rebuilt only when its data or the language changes, not on every render.
  const model = useMemo(
    () => (data.window ? errorChartModel(data.buckets, data.window, (key) => classLabel(t, key)) : null),
    [data.window, data.buckets, t],
  )
  const requests = useMemo(() => ({ label: t("dash.protRequests"), data: model?.requests ?? [] }), [model, t])
  const rangeLabels: Record<ErrorRange, string> = useMemo(
    () => ({ "1h": t("dash.protRange1h"), "24h": t("dash.tlmRange24h"), "7d": t("dash.tlmRange7d"), "30d": t("dash.tlmRange30d") }),
    [t],
  )
  const ranges = useMemo<Array<SegmentedOption<ErrorRange>>>(() => (Object.keys(rangeLabels) as ErrorRange[]).map((value) => ({ value, label: rangeLabels[value] })), [rangeLabels])
  // Named after the range the loaded data belongs to, not one still loading.
  const ariaLabel = useMemo(
    () => (model && data.range ? t("dash.protChartAria", { range: rangeLabels[data.range], ...chartTotals(model) }) : undefined),
    [model, data.range, rangeLabels, t],
  )
  const states = useMemo(
    () => bannerItems(store.pauses.filter((pause) => pause.upstreamId === upstream.id), t, Date.now()),
    [store.pauses, upstream.id, t],
  )
  const save = async (settings: ProtectionSettings) => {
    setSaving(true)
    setServerErrors({})
    try {
      await patchUpstream(upstream.id, { protection: settings })
      toast(t("dash.protSaved"), "success")
      onSaved()
      void store.refresh()
    } catch (error) {
      const failure = saveFailure(error)
      setServerErrors(failure.fieldErrors)
      toast(failure.message ?? t("dash.protSaveFailed"), "error")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div id={`protection-${upstream.id}`} role="region" aria-labelledby={headingId} tabIndex={-1} className="mt-2 space-y-4 rounded-lg border border-border bg-background p-3 sm:p-4">
      <div>
        <SectionHeading as="h3" id={headingId}>{t("dash.protTitle")}</SectionHeading>
        <p className="mt-1 text-xs text-fg-subtle">{t("dash.protIntro")}</p>
      </div>
      <div>
        <div className="mb-1 text-xs font-medium text-fg-muted">{t("dash.protState")}</div>
        <ProtectionStates items={states} resuming={store.resuming} onResume={(id) => { void store.resume(id).then(() => setReloadTick((n) => n + 1)) }} />
      </div>
      <ProtectionSettingsForm saved={saved} saving={saving} onSave={save} serverErrors={serverErrors} onEdit={() => setServerErrors({})} />
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <SectionHeading as="h3">{t("dash.protChartTitle")}</SectionHeading>
          <div className="flex items-center gap-2">
            <SegmentedControl options={ranges} value={range} onChange={setRange} ariaLabel={t("dash.protRangeLabel")} size="sm" />
            <Button variant="ghost" size="sm" onClick={() => setReloadTick((n) => n + 1)}>{t("dash.protRefresh")}</Button>
          </div>
        </div>
        {data.failed ? <Notice tone="danger">{t("dash.protLoadFailed")}</Notice> : null}
        <div aria-busy={data.loading}>
          {model && model.hasData ? <ErrorBarChart labels={model.labels} bars={model.bars} requests={requests} yTitle={t("dash.protAxisCount")} ariaLabel={ariaLabel} />
            : <p className="text-body text-fg-subtle">{data.loading ? t("dash.loadingShort") : t("dash.protChartEmpty")}</p>}
        </div>
        <p className="text-xs text-fg-subtle">{t("dash.protTimesIn", { zone: zoneLabel(Date.now()) })}</p>
      </div>
      <div className="space-y-2">
        <SectionHeading as="h3">{t("dash.protSamplesTitle")}</SectionHeading>
        <ErrorSamplesTable samples={data.samples} />
      </div>
      <div className="space-y-2">
        <SectionHeading as="h3">{t("dash.protHistoryTitle")}</SectionHeading>
        <PauseHistoryTable pauses={data.history} />
      </div>
    </div>
  )
}
