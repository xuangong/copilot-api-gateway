// apps/dashboard/src/tabs/upstreams/groups/MemberQuotaRow.test.tsx
import { afterEach, beforeEach, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { MemberStatus, UpstreamGroup } from "../../../api/upstream-groups"
import { installDictionary } from "../../../state/i18n-fixture"
import { setDisplayZone } from "../../telemetry/telemetry-format"
import { MemberQuotaRow } from "./MemberQuotaRow"

const NOW = Date.UTC(2026, 10, 22, 12, 0)
let restore: () => void = () => {}
beforeEach(() => { setDisplayZone("UTC"); restore = installDictionary("en") })
afterEach(() => { restore(); setDisplayZone(null) })
const group = { id: "ug_1", settings: { softShare: 0.9, hardShare: 0.95 } } as UpstreamGroup
const member = (over: Partial<MemberStatus> = {}): MemberStatus => ({
  upstreamId: "up_a", name: "A", login: "a", enabled: true, unlimited: false, usedShare: 0.5, entitlement: 1000, estimatedUsed: 500, projectedShare: 0.7,
  lastRead: { at: NOW - 2 * 3_600_000, source: "github", used: 450, entitlement: 1000, share: 0.45 }, k: 0.02, kPrevious: 0.03, kSamples: 5, outsideRate: 0.001, outsideShareLastDay: 0.25,
  lastErrorPoints: -2.4, intervalHours: 3, nextReadAt: NOW, failures: 0, lastError: null, readFailing: false, entitlementChange: null, cutOff: null, eligibility: { eligible: true, reason: null }, activeSessions: 2, ...over,
})
const html = (m: MemberStatus, extra: { busy?: boolean; readOnly?: boolean } = {}) =>
  renderToStaticMarkup(<MemberQuotaRow member={m} group={group} nowMs={NOW} busy={extra.busy ?? false} readOnly={extra.readOnly ?? false} onRefresh={() => {}} onCalibrate={() => {}} onRemove={() => {}} />)

test("a member row shows used / entitlement and share, the source and age, the projection, the lines and the details", () => {
  const out = html(member())
  expect(out).toContain("500 / 1,000")
  expect(out).toContain("50%")
  expect(out).toContain("estimate · last read 2 hours ago")
  expect(out).toContain("Projected month end 70%")
  expect(out).toContain("Soft line 90% · hard line 95%")
  expect(out).toContain("2 active sessions")
  expect(out).toContain("25% of the last day&#x27;s usage came from outside the gateway")
  expect(out).toContain("Last estimate error -2.4 points")
  expect(out).toContain("Read every 3 h")
  expect(out).toContain("k 0.02 (before 0.03)")
})

test("the bar has a solid read part, a shaded estimated part and the two line markers", () => {
  const out = html(member())
  expect(out).toContain("width:45%")
  expect(out).toContain("width:5%")
  expect(out).toContain("left:90%")
  expect(out).toContain("left:95%")
})

test("a member that was never read says so and has no figures", () => {
  const out = html(member({ lastRead: null, usedShare: null, estimatedUsed: null, projectedShare: null, eligibility: { eligible: false, reason: "no_read" } }))
  expect(out).toContain("Not read yet: takes no new sessions until it is read or calibrated")
  expect(out).not.toContain("Projected month end")
})

test("an unlimited account shows no bar and no lines", () => {
  const out = html(member({ unlimited: true, usedShare: 0, estimatedUsed: 0, entitlement: null }))
  expect(out).toContain("Unlimited")
  expect(out).not.toContain("left:90%")
})

test("a cut-off member shows until when, a provisional one says the next read decides, an ineligible one says why", () => {
  expect(html(member({ cutOff: { until: Date.UTC(2026, 11, 1), provisional: false, share: 0.96 }, eligibility: { eligible: false, reason: "cut_off" } }))).toContain("Cut off until 12-01 00:00")
  expect(html(member({ cutOff: { until: Date.UTC(2026, 11, 1), provisional: true, share: 0.96 }, eligibility: { eligible: false, reason: "cut_off" } }))).toContain("the next read confirms or lifts it")
  expect(html(member({ usedShare: 0.92, eligibility: { eligible: false, reason: "soft_line" } }))).toContain("Takes no new sessions: at the soft line")
})

test("an entitlement change is shown with both values", () => {
  expect(html(member({ entitlementChange: { from: 1000, to: 2000, at: NOW - 3_600_000 } }))).toContain("Entitlement changed from 1,000 to 2,000 (1 hour ago)")
})

test("Refresh and Calibrate are buttons; a read-only viewer sees none; busy disables Refresh", () => {
  expect(html(member())).toContain(">Refresh<")
  expect(html(member())).toContain(">Calibrate<")
  expect(html(member(), { readOnly: true })).not.toContain(">Refresh<")
  expect(html(member(), { busy: true })).toMatch(/<button[^>]*\sdisabled=""[^>]*>…</)
  expect(html(member())).not.toMatch(/<button[^>]*\sdisabled=""[^>]*>Refresh</)
})

test("unknown values are dashes and words, never 0%", () => {
  const out = html(member({ usedShare: null, estimatedUsed: null, projectedShare: null }))
  expect(out).toContain("—")
  expect(out).toContain("unknown")
  expect(out).not.toContain("(0%)")
  expect(out).not.toContain("left:90%")
})

test("a member whose reads keep failing says so in words", () => {
  const out = html(member({ readFailing: true, lastError: "HTTP 502", failures: 3 }))
  expect(out).toContain("Reads keep failing")
  expect(out).toContain("Last read failed: HTTP 502")
})

test("a member that was never read says it takes no sessions until calibrated or its credential is fixed", () => {
  const out = html(member({ readFailing: true, readFailingReason: "never_read", failures: 2, usedShare: null }))
  expect(out).toContain("Never read")
  expect(out).toContain("calibrate it or fix its GitHub credential")
  expect(out).not.toContain("Reads keep failing")
})

test("the buttons are named per member for assistive technology; the bar is decorative because the figures carry the numbers", () => {
  const out = html(member())
  expect(out).toContain('aria-label="Refresh A"')
  expect(out).toContain('aria-label="Calibrate A"')
  expect(out).toContain('aria-label="Remove A from group"')
  expect(out).toContain('aria-hidden="true"')
})

test("the member row is a labelled group named after the member", () => {
  expect(html(member())).toMatch(/role="group"[^>]*aria-label="A"/)
})

test("the same row in Chinese", () => {
  restore(); restore = installDictionary("zh")
  const out = html(member())
  expect(out).toContain("预计月底 70%")
  expect(out).toContain("软限制 90% · 硬限制 95%")
})
