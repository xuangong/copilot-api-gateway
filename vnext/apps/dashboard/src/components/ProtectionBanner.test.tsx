// apps/dashboard/src/components/ProtectionBanner.test.tsx
import { afterEach, beforeEach, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { PauseReason, ProtectionPause } from "../api/protection"
import { installDictionary } from "../state/i18n-fixture"
import { setDisplayZone } from "../tabs/telemetry/telemetry-format"
import { bannerItems } from "./protection-banner-model"
import { ProtectionBanner } from "./ProtectionBanner"

const NOW = Date.UTC(2026, 10, 17, 12, 0)
let restore: () => void = () => {}
beforeEach(() => { setDisplayZone("UTC"); restore = installDictionary("en") })
afterEach(() => { restore(); setDisplayZone(null) })

const reason = (over: Partial<PauseReason> = {}): PauseReason => ({
  windowMinutes: 5, requests: 50, risky: 46, counts: { rate_limited: 46, rejected: 0, auth: 0, upstream: 0, network: 0, other: 0 },
  failureRatio: 0.92, topKeys: [], trigger: "ratio", keyShare: null, ...over,
})
const pause = (over: Partial<ProtectionPause> = {}): ProtectionPause => ({
  id: "pp_" + "1".repeat(32), targetKind: "upstream", targetId: "up_a", targetName: "Copilot A", upstreamId: "up_a", upstreamName: "Copilot A", mode: "pause",
  reason: reason(), canResume: true, startedAt: NOW - 60_000, endsAt: Date.UTC(2026, 10, 17, 18, 40), resolvedAt: null, endedBy: null, ...over,
})
const text = (p: ProtectionPause) => bannerItems([p], window.t!, NOW)[0]!.text

test("an upstream pause reads as the spec's sentence", () => {
  expect(text(pause())).toBe("Upstream Copilot A paused until 18:40 — 46 rate-limit errors in 5 min (92% of requests).")
})

test("a key pause names the key and the upstream; the date is added when the end is on another day", () => {
  expect(text(pause({ targetKind: "key", targetId: "key_1", targetName: "CI key", upstreamName: "Copilot A" })))
    .toBe("API key CI key paused until 18:40 — 46 rate-limit errors in 5 min (92% of requests) on upstream Copilot A.")
  expect(text(pause({ endsAt: Date.UTC(2026, 10, 18, 2, 10) }))).toContain("paused until 11-18 02:10")
})

test("warnings (notify) say the upstream or key is receiving an error flood", () => {
  expect(text(pause({ mode: "notify" }))).toBe("Upstream Copilot A is receiving an error flood — 46 rate-limit errors in 5 min (92% of requests).")
  expect(text(pause({ mode: "notify", targetKind: "key", targetName: "CI key" })))
    .toBe("API key CI key is causing an error flood on upstream Copilot A — 46 rate-limit errors in 5 min (92% of requests).")
})

test("the summary names the dominant risky class", () => {
  const rejected = reason({ counts: { rate_limited: 3, rejected: 30, auth: 1, upstream: 0, network: 0, other: 0 }, risky: 34, failureRatio: 0.68 })
  expect(text(pause({ reason: rejected }))).toContain("30 rejected-request errors in 5 min (68% of requests)")
  const auth = reason({ counts: { rate_limited: 0, rejected: 0, auth: 5, upstream: 0, network: 0, other: 0 }, risky: 5, failureRatio: 0.004 })
  expect(text(pause({ reason: auth }))).toContain("5 authentication errors in 5 min (0% of requests)")
})

test("the same sentence in Chinese", () => {
  restore()
  restore = installDictionary("zh")
  expect(text(pause())).toBe("上游 Copilot A 已暂停至 18:40 — 5 分钟内 46 个限流错误（占请求的 92%）。")
  expect(text(pause({ targetKind: "key", targetName: "CI key", upstreamId: "", upstreamName: "" })))
    .toBe("API 密钥 CI key 已暂停至 18:40 — 5 分钟内 46 个限流错误（占请求的 92%），原因是某个上游的错误。")
})

test("pauses come before warnings, newest first; only pauses can be resumed", () => {
  const items = bannerItems([
    pause({ id: "pp_" + "a".repeat(32), mode: "notify", startedAt: 3 }),
    pause({ id: "pp_" + "b".repeat(32), startedAt: 1 }),
    pause({ id: "pp_" + "c".repeat(32), startedAt: 2 }),
  ], window.t!, NOW)
  expect(items.map(item => [item.id.slice(3, 4), item.canResume, item.tone])).toEqual([["c", true, "danger"], ["b", true, "danger"], ["a", false, "warn"]])
})

test("the banner shows each item with Resume now for pauses and a link only when the viewer can open the upstream", () => {
  const items = bannerItems([pause(), pause({ id: "pp_" + "2".repeat(32), mode: "notify" })], window.t!, NOW)
  const html = renderToStaticMarkup(<ProtectionBanner items={items} onResume={() => {}} onOpen={() => {}} canOpen={item => item.canResume} />)
  expect(html).toContain('role="region"')
  expect(html).toContain("Upstream protection")
  expect(html.match(/Resume now/g)).toHaveLength(1)
  expect(html.match(/Protection settings/g)).toHaveLength(1)
  expect(html).toContain("is receiving an error flood")
})

test("Resume now follows canResume, and a pause on someone else's upstream is worded without a name", () => {
  const foreign = pause({ targetKind: "key", targetId: "key_1", targetName: "CI key", upstreamId: "", upstreamName: "", canResume: false })
  expect(text(foreign)).toBe("API key CI key paused until 18:40 — 46 rate-limit errors in 5 min (92% of requests) on an upstream.")
  expect(text({ ...foreign, mode: "notify" })).toBe("API key CI key is causing an error flood on an upstream — 46 rate-limit errors in 5 min (92% of requests).")
  const [item] = bannerItems([foreign], window.t!, NOW)
  expect(item!.canResume).toBe(false)
  expect(item!.upstreamId).toBe("")
  const html = renderToStaticMarkup(<ProtectionBanner items={[item!]} onResume={() => {}} onOpen={() => {}} canOpen={i => i.upstreamId !== ""} />)
  expect(html).not.toContain("Resume now")
  expect(html).not.toContain("Protection settings")
})

test("without items nothing is rendered", () => {
  expect(renderToStaticMarkup(<ProtectionBanner items={[]} onResume={() => {}} onOpen={() => {}} canOpen={() => true} />)).toBe("")
})

test("persistent pauses are status regions, not alerts, and Resume is disabled while it is pending", () => {
  const items = bannerItems([pause()], window.t!, NOW)
  const html = renderToStaticMarkup(<ProtectionBanner items={items} onResume={() => {}} onOpen={() => {}} canOpen={() => false} resuming={new Set([items[0]!.id])} />)
  expect(html).toContain('role="status"')
  expect(html).not.toContain('role="alert"')
  expect(html).toMatch(/<button[^>]*disabled[^>]*>Resume now/)
})
