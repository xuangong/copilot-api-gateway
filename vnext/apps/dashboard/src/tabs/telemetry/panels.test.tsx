import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { TelemetryBudget, TelemetrySummary, TelemetryTop } from "../../api/telemetry"
import { installDictionary } from "../../state/i18n-fixture"
import { AvailabilityPanel } from "./AvailabilityPanel"
import { ChartPanel } from "./ChartPanel"
import { BudgetPanel, CheckStrip, FlaggedPanel, FreshnessPanel, LatencyNote, TopPanel } from "./Panels"
import { SETTINGS_FIELDS, SettingsPanel, type SettingsPanelProps } from "./SettingsPanel"
import { setDisplayZone } from "./telemetry-format"
import { settingsToForm } from "./telemetry-settings-form"

setDisplayZone("UTC")

const summary = (over: Partial<TelemetrySummary> = {}): TelemetrySummary => ({
  now: "2026-11-16T12:30:00.000Z", freshness: { lastPushAt: "2026-11-16T09:00:00.000Z", stale: false, staleAfterHours: 2, hoursSincePush: 3 }, budget: null,
  surges: [], flags: [], checks: [], ...over,
})
const check = (status: "passed" | "failed" | "no check" | "not monitored", stage: string | null = null) => ({ metric: "probe.ok", hour: "2026-11-16T11:00:00Z", status, stage })

test("freshness shows the last push, and a stale source gets the staleness warning", () => {
  expect(renderToStaticMarkup(<FreshnessPanel summary={null} />)).toContain("dash.loadingShort")
  const fresh = renderToStaticMarkup(<FreshnessPanel summary={summary()} />)
  expect(fresh).toContain("dash.tlmLastPush")
  expect(fresh).not.toContain("dash.tlmStaleWarning")
  expect(renderToStaticMarkup(<FreshnessPanel summary={summary({ freshness: { lastPushAt: null, stale: false, staleAfterHours: 2, hoursSincePush: null } })} />)).toContain("dash.tlmNeverPushed")
  expect(renderToStaticMarkup(<FreshnessPanel summary={summary({ freshness: { lastPushAt: "x", stale: true, staleAfterHours: 2, hoursSincePush: 5 } })} />)).toContain("dash.tlmStaleWarning")
})

test("each check status is worded as a single check, and only no check warns, alongside a staleness warning when both apply", () => {
  const html = (status: Parameters<typeof check>[0], stage: string | null = null, stale = false) => renderToStaticMarkup(
    <FreshnessPanel summary={summary({ checks: [check(status, stage)], freshness: { lastPushAt: "2026-11-16T09:00:00.000Z", stale, staleAfterHours: 2, hoursSincePush: 3 } })} />)
  expect(html("passed")).toContain("dash.tlmCheckPassed")
  expect(html("passed")).not.toContain("dash.tlmNoCheckWarning")
  const failed = html("failed", "tls")
  expect(failed).toContain("dash.tlmCheckFailed")
  expect(failed).toContain("dash.tlmCheckStage")
  expect(html("not monitored")).toContain("dash.tlmCheckNotMonitored")
  expect(html("not monitored")).not.toContain("dash.tlmNoCheckWarning")
  const none = html("no check")
  expect(none).toContain("dash.tlmCheckNoCheck")
  expect(none).toContain("dash.tlmNoCheckWarning")
  expect(none).not.toContain("dash.tlmStaleWarning")
  const both = html("no check", null, true)
  expect(both).toContain("dash.tlmStaleWarning")
  expect(both).toContain("dash.tlmNoCheckWarning")
})

test("the single-check sentence says it reflects only the moment of the check, in both languages", () => {
  for (const language of ["en", "zh"] as const) {
    const restore = installDictionary(language)
    try {
      const html = renderToStaticMarkup(<FreshnessPanel summary={summary({ checks: [check("passed")] })} />)
      expect(html).toContain("11:00–12:00")
      expect(html).not.toContain("dash.tlmCheckPassed")
    } finally { restore() }
  }
  const zh = installDictionary("zh")
  try {
    expect(renderToStaticMarkup(<FreshnessPanel summary={summary({ checks: [check("passed")] })} />)).toContain("11:00–12:00 期间的一次检测：正常（只代表检测时那一刻）")
  } finally { zh() }
  const restore = installDictionary("en")
  try {
    expect(renderToStaticMarkup(<FreshnessPanel summary={summary({ checks: [check("passed")] })} />)).toContain("One check during 11:00–12:00: passed (this reflects only the moment of the check)")
    expect(renderToStaticMarkup(<FreshnessPanel summary={summary({ checks: [check("no check")] })} />)).toContain("the VM may be down or the agent not running")
  } finally { restore() }
})

const budget = (over: Partial<TelemetryBudget> = {}): TelemetryBudget => ({
  metric: "nic.tx_bytes", unit: "bytes", monthStart: "2026-11-01T00:00:00Z", mtd: 372e9, projection: 719.5e9, averageDaily: 24e9, monthlyLimit: 500e9,
  mtdPercent: 74.4, projectionPercent: 143.9, overLimit: true, cost: { mtd: 27.2, projection: 61.95 }, ...over,
})

test("the budget panel shows month-to-date, the projection, a red bar and an alert when the projection exceeds the limit, and the cost", () => {
  expect(renderToStaticMarkup(<BudgetPanel budget={null} />)).toContain("dash.tlmBudgetUnset")
  const html = renderToStaticMarkup(<BudgetPanel budget={budget()} />)
  expect(html).toContain("372 GB")
  expect(html).toContain("719.5 GB")
  expect(html).toContain("500 GB")
  expect(html).toContain("bg-danger")
  expect(html).toContain("dash.tlmOverLimit")
  expect(html).toContain('role="alert"')
  expect(html).toContain("dash.tlmCost")
  const calm = renderToStaticMarkup(<BudgetPanel budget={budget({ overLimit: false, mtdPercent: 40, projection: 450e9, cost: null })} />)
  expect(calm).toContain("bg-brand")
  expect(calm).not.toContain("dash.tlmOverLimit")
  expect(calm).not.toContain("dash.tlmCost")
  expect(renderToStaticMarkup(<BudgetPanel budget={budget({ monthlyLimit: null, mtdPercent: null, projectionPercent: null, overLimit: null, cost: null })} />)).not.toContain("dash.tlmPercentOfLimit")
})

test("the check strip draws one bar per hour: passed green, failed red, no check amber and hours without a check short and neutral, never a percentage", () => {
  const hours = ["2026-11-16T09:00:00Z", "2026-11-16T10:00:00Z", "2026-11-16T11:00:00Z", "2026-11-16T12:00:00Z"]
  const html = renderToStaticMarkup(<CheckStrip hours={hours} statuses={["not monitored", "passed", "failed", "no check"]} stages={[null, null, "tls", null]} nowMs={Date.parse("2026-11-17T00:00:00Z")} />)
  const bars = html.match(/<span[^>]*data-status="[^"]*"[^>]*>/g) ?? []
  expect(bars).toHaveLength(4)
  expect(bars[0]).toContain("h-1")
  expect(bars[1]).toContain("bg-success")
  expect(bars[2]).toContain("bg-danger")
  expect(bars[3]).toContain("bg-warn")
  expect(html).toContain("11-16 11:00 dash.tlmStatusFailed (tls)")
  expect(html).not.toContain("%")
})

const top = (over: Partial<TelemetryTop> = {}): TelemetryTop => ({
  metric: "proxy.sent_bytes", unit: "bytes", groupBy: "user", from: "a", to: "b", previousFrom: "c", previousTo: "d", total: 100e9,
  rows: [{ key: "#1", value: 60e9, share: 0.6, previous: 30e9, change: 1 }, { key: "", value: 20e9, share: 0.2, previous: 0, change: null }], otherCurrent: 20e9, otherShare: 0.2, ...over,
})

test("the top table shows labelled groups with value, share and change, the empty group and the remainder", () => {
  const html = renderToStaticMarkup(<TopPanel top={top()} settings={{ labels: { user: { "#1": "MacBook" } } }} groupBy="user" />)
  expect(html).toContain("MacBook")
  expect(html).toContain("60 GB")
  expect(html).toContain("60.0%")
  expect(html).toContain("+100%")
  expect(html).toContain("dash.tlmNoGroup")
  expect(html).toContain("dash.tlmOtherLabel")
  expect(html).toContain("—")
  expect(renderToStaticMarkup(<TopPanel top={null} settings={{}} groupBy="" />)).toContain("dash.tlmTopPick")
  expect(renderToStaticMarkup(<TopPanel top={top({ rows: [], total: 0, otherCurrent: 0, otherShare: 0 })} settings={{}} groupBy="user" />)).toContain("dash.tlmNoData")
})

test("flagged hours list surges with ratio and contributors and non-zero hours with their breakdown", () => {
  const html = renderToStaticMarkup(<FlaggedPanel units={{ "nic.tx_bytes": "bytes", "probe.fail": "count" }} settings={{ labels: { user: { "#1": "MacBook" } } }} summary={summary({
    surges: [{ metric: "nic.tx_bytes", hour: "2026-11-16T11:00:00Z", value: 5e9, baseline: 1e9, ratio: 5, contributors: [{ dims: { user: "#1" }, value: 4e9 }] }],
    flags: [{ metric: "probe.fail", hour: "2026-11-16T09:00:00Z", total: 1, breakdown: [{ dims: { stage: "tls" }, value: 1 }] }],
  })} />)
  expect(html).toContain("dash.tlmSurges")
  expect(html).toContain("5 GB")
  expect(html).toContain("×5.0")
  expect(html).toContain("user=MacBook")
  expect(html).toContain("dash.tlmNonZero")
  expect(html).toContain("stage=tls")
  expect(renderToStaticMarkup(<FlaggedPanel units={{}} settings={{}} summary={summary()} />)).toContain("dash.tlmNoFlags")
})

const noop = () => {}
const settingsProps = (over: Partial<SettingsPanelProps> = {}): SettingsPanelProps => ({
  form: settingsToForm({}, null), name: "trojan-vm", busy: false, error: "", saved: false, invalidField: null, onField: noop, onName: noop, onSave: noop,
  onRename: noop, onRotate: noop, onDelete: noop, limitState: "ready", ...over,
})

test("the settings panel has every setting, rename, rotate and delete, and marks an invalid field", () => {
  const html = renderToStaticMarkup(<SettingsPanel {...settingsProps()} />)
  for (const field of SETTINGS_FIELDS) expect(html).toContain(field.labelKey)
  expect(html).toContain("dash.save")
  expect(html).toContain("dash.tlmRename")
  expect(html).toContain("dash.tlmRotate")
  expect(html).toContain("dash.delete")
  expect(renderToStaticMarkup(<SettingsPanel {...settingsProps({ invalidField: "surgeFactor" })} />)).toContain('aria-invalid="true"')
  expect(renderToStaticMarkup(<SettingsPanel {...settingsProps({ saved: true })} />)).toContain("dash.tlmSettingsSaved")
  expect(renderToStaticMarkup(<SettingsPanel {...settingsProps({ error: "dash.tlmError" })} />)).toContain('role="alert"')
})

test("every settings label exists in English and Chinese", () => {
  for (const language of ["en", "zh"] as const) {
    const restore = installDictionary(language)
    try {
      const html = renderToStaticMarkup(<SettingsPanel {...settingsProps()} />)
      expect(html).not.toContain("dash.tlm")
    } finally { restore() }
  }
})

test("the top table and flagged contributors hide groups whose value is zero", () => {
  const rows = [{ key: "#1", value: 60e9, share: 1, previous: 0, change: null }, { key: "ghost", value: 0, share: 0, previous: 0, change: null }]
  const html = renderToStaticMarkup(<TopPanel top={top({ rows, otherCurrent: 0, otherShare: 0 })} settings={{}} groupBy="user" />)
  expect(html).toContain("#1")
  expect(html).not.toContain("ghost")
  expect(renderToStaticMarkup(<TopPanel top={top({ rows: [rows[1]!], total: 0, otherCurrent: 0, otherShare: 0 })} settings={{}} groupBy="user" />)).toContain("dash.tlmNoData")
  const flagged = renderToStaticMarkup(<FlaggedPanel units={{ m: "count" }} settings={{}} summary={summary({
    flags: [{ metric: "m", hour: "2026-11-16T09:00:00Z", total: 1, breakdown: [{ dims: { stage: "tls" }, value: 1 }, { dims: { stage: "tcp" }, value: 0 }] }],
  })} />)
  expect(flagged).toContain("stage=tls")
  expect(flagged).not.toContain("stage=tcp")
})

test("a latency chart says that only passed hours are shown", () => {
  expect(renderToStaticMarkup(<LatencyNote check="probe.ok" metric="probe.latency_ms" />)).toContain("dash.tlmLatencyPassedOnly")
  expect(renderToStaticMarkup(<LatencyNote check={null} metric="probe.latency_ms" />)).toContain("dash.tlmLatencyUnpaired")
  expect(renderToStaticMarkup(<LatencyNote check={null} metric="nic.tx_bytes" />)).toBe("")
})

test("failures and missing checks are also named in text, and the legend lists only the states shown", () => {
  const hours = ["2026-11-16T09:00:00Z", "2026-11-16T10:00:00Z", "2026-11-16T11:00:00Z", "2026-11-16T12:00:00Z", "2026-11-16T13:00:00Z"]
  const now = Date.parse("2026-11-16T13:30:00Z")
  const html = renderToStaticMarkup(<CheckStrip hours={hours} statuses={["not monitored", "passed", "failed", "no check", "no check"]} stages={[null, null, "tls", null, null]} nowMs={now} />)
  const text = html.replace(/<[^>]*>/g, "")
  expect(text).toContain("dash.tlmStatusFailed: 11-16 11:00 (tls)")
  expect(text).toContain("dash.tlmStatusNoCheck: 11-16 12:00")
  expect(html.match(/data-status="pending"/g)).toHaveLength(1)
  const legend = html.slice(html.indexOf("<ul"))
  for (const key of ["dash.tlmStatusPassed", "dash.tlmStatusFailed", "dash.tlmStatusNoCheck", "dash.tlmStatusNotMonitored", "dash.tlmStatusPending"]) expect(legend).toContain(key)
  const allPassed = renderToStaticMarkup(<CheckStrip hours={hours.slice(1, 3)} statuses={["passed", "passed"]} stages={[]} nowMs={now} />)
  expect(allPassed).toContain("dash.tlmChecksAllPassed")
  expect(allPassed.slice(allPassed.indexOf("<ul"))).not.toContain("dash.tlmStatusFailed")
})

test("a failed load is shown instead of an endless Loading", () => {
  expect(renderToStaticMarkup(<FreshnessPanel summary={null} failed />)).toContain("dash.tlmLoadError")
  expect(renderToStaticMarkup(<FreshnessPanel summary={null} failed />)).not.toContain("dash.loadingShort")
  expect(renderToStaticMarkup(<FlaggedPanel units={{}} settings={{}} summary={null} failed />)).toContain("dash.tlmLoadError")
  expect(renderToStaticMarkup(<TopPanel top={null} settings={{}} groupBy="user" failed />)).toContain("dash.tlmLoadError")
  const chart = renderToStaticMarkup(<ChartPanel metrics={[]} metric="" range="24h" groupBy="" series={null} settings={{}} surgeHours={new Set()} dark error="dash.tlmLoadError" onMetric={noop} onRange={noop} onGroupBy={noop} />)
  expect(chart).toContain("dash.tlmLoadError")
  expect(chart).not.toContain("dash.tlmNoMetrics")
})

test("hours in flagged tables and the last push are shown in the display zone", () => {
  const html = renderToStaticMarkup(<FlaggedPanel units={{ m: "count" }} settings={{}} summary={summary({
    flags: [{ metric: "m", hour: "2026-11-16T09:00:00Z", total: 1, breakdown: [] }],
  })} />)
  expect(html).toContain("11-16 09:00")
})

test("settings fields match the form fields exactly", () => {
  expect((SETTINGS_FIELDS.map(field => field.key) as string[]).sort()).toEqual(Object.keys(settingsToForm({}, null)).filter(key => key !== "limitUnit").sort())
})

test("the limit field and Save are disabled until the unit is known, with a hint for each limit state", () => {
  const disabledSave = (html: string) => /<button[^>]*\sdisabled=""[^>]*>[^<]*dash\.save/.test(html)
  const loading = renderToStaticMarkup(<SettingsPanel {...settingsProps({ limitState: "loading" })} />)
  expect(loading).toContain("dash.tlmLimitLoading")
  expect(disabledSave(loading)).toBe(true)
  expect(/<input[^>]*disabled=""[^>]*value=""[^>]*>/.test(loading)).toBe(true)
  expect(renderToStaticMarkup(<SettingsPanel {...settingsProps({ limitState: "raw" })} />)).toContain("dash.tlmLimitRaw")
  const mismatch = renderToStaticMarkup(<SettingsPanel {...settingsProps({ limitState: "mismatch" })} />)
  expect(mismatch).toContain("dash.tlmLimitMismatch")
  expect(disabledSave(mismatch)).toBe(true)
  const ready = renderToStaticMarkup(<SettingsPanel {...settingsProps()} />)
  expect(disabledSave(ready)).toBe(false)
  expect(ready).not.toContain("dash.tlmLimit")
})

test("a check series is judged by when it was fetched, so a later render does not turn the open hour into a no-check warning", () => {
  const series = { metric: "probe.ok", unit: "count" as const, from: "2026-11-16T12:00:00Z", to: "2026-11-16T14:00:00Z", hours: ["2026-11-16T12:00:00Z", "2026-11-16T13:00:00Z"],
    total: [1, 0], groups: [], statuses: ["passed" as const, "no check" as const], stages: [null, null] }
  const html = renderToStaticMarkup(<ChartPanel metrics={[{ metric: "probe.ok", unit: "count", firstHour: "", lastHour: "", dims: [] }]} metric="probe.ok" range="24h" groupBy=""
    series={series} fetchedAt={Date.parse("2026-11-16T13:02:00Z")} settings={{ checkMetrics: ["probe.ok"] }} surgeHours={new Set()} dark error="" onMetric={noop} onRange={noop} onGroupBy={noop} />)
  expect(html).toContain('data-status="pending"')
  expect(html).not.toContain('data-status="no check"')
})

test("the metric picker names the metric's unit", () => {
  const restore = installDictionary("en")
  try {
    const html = renderToStaticMarkup(<ChartPanel metrics={[{ metric: "proxy.connections", unit: "count", firstHour: "", lastHour: "", dims: [] }, { metric: "proxy.sent_bytes", unit: "bytes", firstHour: "", lastHour: "", dims: [] }]}
      metric="proxy.connections" range="24h" groupBy="" series={null} settings={{}} surgeHours={new Set()} dark error="" onMetric={noop} onRange={noop} onGroupBy={noop} />)
    expect(html).toContain("proxy.connections (count)")
    const sent = renderToStaticMarkup(<ChartPanel metrics={[{ metric: "proxy.sent_bytes", unit: "bytes", firstHour: "", lastHour: "", dims: [] }]}
      metric="proxy.sent_bytes" range="24h" groupBy="" series={null} settings={{}} surgeHours={new Set()} dark error="" onMetric={noop} onRange={noop} onGroupBy={noop} />)
    expect(sent).toContain("proxy.sent_bytes · download (bytes)")
  } finally { restore() }
})

test("the availability panel shows one marker per hour with the failing stage and the single-check hint, never a percentage", () => {
  const restore = installDictionary("en")
  try {
    const hours = ["2026-11-16T12:00:00Z", "2026-11-16T13:00:00Z"]
    const checkSeries = { metric: "probe.ok", unit: "count" as const, from: hours[0]!, to: "2026-11-16T14:00:00Z", hours, total: [1, 0], groups: [],
      statuses: ["passed" as const, "failed" as const], stages: [null, "tls"] }
    const html = renderToStaticMarkup(<AvailabilityPanel data={[{ check: "probe.ok", checkSeries, latency: null }]} range="24h" fetchedAt={Date.parse("2026-11-16T15:00:00Z")} dark error="" onRange={noop} />)
    expect(html).toContain("Availability")
    expect(html).toContain('data-status="passed"')
    expect(html).toContain('data-status="failed"')
    expect(html).toContain("(tls)")
    expect(html).toContain("reflects only the moment of that check")
    expect(html).not.toContain("%")
  } finally { restore() }
})

test("the chosen metric is explained, and every built-in explanation exists in English and Chinese", () => {
  const restore = installDictionary("en")
  try {
    const html = renderToStaticMarkup(<ChartPanel metrics={[{ metric: "nic.tx_bytes", unit: "bytes", firstHour: "", lastHour: "", dims: [] }]}
      metric="nic.tx_bytes" range="24h" groupBy="" series={null} settings={{}} surgeHours={new Set()} dark error="" onMetric={noop} onRange={noop} onGroupBy={noop} />)
    expect(html).toContain("Azure bills outbound traffic")
  } finally { restore() }
  for (const language of ["en", "zh"] as const) {
    const undo = installDictionary(language)
    try {
      for (const metric of ["nic.total_bytes", "nic.tx_bytes", "nic.rx_bytes", "proxy.sent_bytes", "proxy.recv_bytes", "proxy.total_bytes", "proxy.connections", "probe.ok", "probe.fail", "probe.latency_ms", "custom.metric"]) {
        const html = renderToStaticMarkup(<ChartPanel metrics={[{ metric, unit: "count", firstHour: "", lastHour: "", dims: [] }]}
          metric={metric} range="24h" groupBy="" series={null} settings={{}} surgeHours={new Set()} dark error="" onMetric={noop} onRange={noop} onGroupBy={noop} />)
        expect(html).not.toContain("dash.tlmAbout")
        if (metric !== "custom.metric") expect(html).toMatch(/<p class="text-xs text-fg-muted">[^<]{20,}<\/p>/)
      }
    } finally { undo() }
  }
})

test("the traffic chart shows the total for the chosen window, date fields for a custom period, and a notice instead of a chart for a bad period", () => {
  const restore = installDictionary("en")
  try {
    const series = { metric: "nic.tx_bytes", unit: "bytes" as const, from: "2026-11-01T00:00:00Z", to: "2026-11-01T02:00:00Z", hours: ["2026-11-01T00:00:00Z", "2026-11-01T01:00:00Z"], total: [1e9, 2.5e9], groups: [] }
    const metrics = [{ metric: "nic.tx_bytes", unit: "bytes" as const, firstHour: "", lastHour: "", dims: [] }]
    const html = renderToStaticMarkup(<ChartPanel metrics={metrics} metric="nic.tx_bytes" range="custom" customStart="2026-11-01" customEnd="2026-11-01" today="2026-11-17"
      windowLabel="11-01 00:00 – 11-02 00:00" series={series} groupBy="" settings={{}} surgeHours={new Set()} dark error="" onMetric={noop} onRange={noop} onGroupBy={noop} />)
    expect(html).toContain('type="date"')
    expect(html).toContain("Total for 11-01 00:00 – 11-02 00:00")
    expect(html).toContain("3.5 GB")
    const bad = renderToStaticMarkup(<ChartPanel metrics={metrics} metric="nic.tx_bytes" range="custom" customStart="2026-08-01" customEnd="2026-11-17" rangeError="Choose at most 90 days."
      series={null} groupBy="" settings={{}} surgeHours={new Set()} dark error="" onMetric={noop} onRange={noop} onGroupBy={noop} />)
    expect(bad).toContain("Choose at most 90 days.")
    expect(bad).not.toContain("Total for")
    expect(bad).not.toContain("dash.loadingShort")
  } finally { restore() }
})

test("the top table says why no change is shown when the previous period has no data", () => {
  const html = renderToStaticMarkup(<TopPanel top={top({ comparable: false, rows: [{ key: "#1", value: 60e9, share: 1, previous: 0, change: null }], otherCurrent: 0, otherShare: 0 })} settings={{}} groupBy="user" />)
  expect(html).toContain("dash.tlmNotComparable")
  expect(html).toContain("—")
  expect(renderToStaticMarkup(<TopPanel top={top()} settings={{}} groupBy="user" />)).not.toContain("dash.tlmNotComparable")
})

const sentMetric = { metric: "proxy.sent_bytes", unit: "bytes" as const, firstHour: "", lastHour: "", dims: ["domain", "user"] }
const filterSeries = { metric: "proxy.sent_bytes", unit: "bytes" as const, from: "2026-11-16T06:00:00Z", to: "2026-11-16T08:00:00Z", hours: ["2026-11-16T06:00:00Z", "2026-11-16T07:00:00Z"], total: [1e9, 2e9], groups: [] }
const filterPanel = (over: Partial<Parameters<typeof ChartPanel>[0]> = {}) => renderToStaticMarkup(<ChartPanel metrics={[sentMetric]} metric="proxy.sent_bytes" range="24h" groupBy="" series={filterSeries}
  windowLabel="11-16 06:00 – 11-16 08:00" settings={{ labels: { user: { "#1": "MacBook" } } }} surgeHours={new Set()} dark error="" onMetric={noop} onRange={noop} onGroupBy={noop} {...over} />)

test("the Only selector appears for a metric with two dims, lists the dim's values by name and puts the filter in the total line", () => {
  const restore = installDictionary("en")
  try {
    const plain = filterPanel({ filterKey: "user", filterValues: ["#1", "#2"], filter: null })
    expect(plain).toContain('aria-label="Only"')
    expect(plain).toContain("Total for 11-16 06:00 – 11-16 08:00:")
    const active = filterPanel({ filterKey: "user", filterValues: ["#1", "#2"], filter: { key: "user", value: "#1" } })
    expect(active).toContain("Total for 11-16 06:00 – 11-16 08:00 · user #1 (MacBook):")
    expect(active).toContain("#1 (MacBook)")
    // No selector without a filter dim, and none for a check metric.
    expect(filterPanel({ filterKey: null })).not.toContain('aria-label="Only"')
    expect(filterPanel()).not.toContain('aria-label="Only"')
    expect(filterPanel({ settings: { checkMetrics: ["proxy.sent_bytes"] }, filterKey: "user" })).not.toContain('aria-label="Only"')
  } finally { restore() }
})

test("the Only label and all-option are translated, and the top table names its filter", () => {
  const zh = installDictionary("zh")
  try {
    const html = filterPanel({ filterKey: "user", filterValues: [], filter: { key: "user", value: "#1" } })
    expect(html).toContain('aria-label="仅看"')
    expect(html).toContain("累计 · user #1 (MacBook)")
  } finally { zh() }
  const restore = installDictionary("en")
  try {
    const html = renderToStaticMarkup(<TopPanel top={top({ groupBy: "domain", filter: { key: "user", value: "#1" } })} settings={{ labels: { user: { "#1": "MacBook" } } }} groupBy="domain" />)
    expect(html).toContain("Only user #1 (MacBook)")
    expect(renderToStaticMarkup(<TopPanel top={top()} settings={{}} groupBy="user" />)).not.toContain("Only")
  } finally { restore() }
})

test("flagged hours follow the display zone", () => {
  setDisplayZone("Asia/Shanghai")
  try {
    const html = renderToStaticMarkup(<FlaggedPanel units={{ m: "count" }} settings={{}} summary={summary({
      flags: [{ metric: "m", hour: "2026-11-16T16:00:00Z", total: 1, breakdown: [] }],
    })} />)
    expect(html).toContain("11-17 00:00")
    const restore = installDictionary("en")
    try {
      const fresh = renderToStaticMarkup(<FreshnessPanel summary={summary({ freshness: { lastPushAt: "2026-11-16T21:05:00.000Z", stale: false, staleAfterHours: 2, hoursSincePush: 1 } })} />)
      expect(fresh).toContain("last push 2026-11-17 05:05")
      expect(renderToStaticMarkup(<FreshnessPanel summary={summary({ checks: [check("passed")] })} />)).toContain("19:00–20:00")
    } finally { restore() }
  } finally { setDisplayZone("UTC") }
})

test("the budget panel says its month is the UTC month", () => {
  const html = renderToStaticMarkup(<BudgetPanel budget={{ metric: "m", unit: "count", mtd: 1, projection: 2, monthlyLimit: null, mtdPercent: null, projectionPercent: null } as unknown as TelemetryBudget} />)
  expect(html).toContain("dash.tlmMtd")
})
