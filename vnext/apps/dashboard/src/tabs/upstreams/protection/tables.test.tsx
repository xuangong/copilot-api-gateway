// apps/dashboard/src/tabs/upstreams/protection/tables.test.tsx
import { afterEach, beforeEach, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { ErrorSample, ProtectionPause } from "../../../api/protection"
import { installDictionary } from "../../../state/i18n-fixture"
import { setDisplayZone } from "../../telemetry/telemetry-format"
import { ErrorSamplesTable } from "./ErrorSamplesTable"
import { PauseHistoryTable } from "./PauseHistoryTable"

let restore: () => void = () => {}
beforeEach(() => { setDisplayZone("UTC"); restore = installDictionary("en") })
afterEach(() => { restore(); setDisplayZone(null) })

const AT = Date.UTC(2026, 10, 17, 18, 5)
const sample = (over: Partial<ErrorSample> = {}): ErrorSample =>
  ({ upstreamId: "up_a", status: 429, at: AT, keyId: "key_abcdefghijkl", model: "gpt-x", code: "rate_limit_exceeded", message: "Slow down", ...over })

test("samples show status, code, message, local time, key and model; network failures read Network", () => {
  const html = renderToStaticMarkup(<ErrorSamplesTable samples={[sample(), sample({ status: 0, code: "", message: "TypeError", keyId: "" })]} />)
  for (const text of ["Status", "Code", "Message", "Time", "Key", "Model", "429", "rate_limit_exceeded", "Slow down", "2026-11-17 18:05", "key_abcd", "gpt-x", "Network", "TypeError"]) expect(html, text).toContain(text)
  expect(html).toContain('title="key_abcdefghijkl"')
  expect(renderToStaticMarkup(<ErrorSamplesTable samples={[]} />)).toContain("No errors recorded for this upstream.")
})

test("messages are rendered as text, never as markup", () => {
  const html = renderToStaticMarkup(<ErrorSamplesTable samples={[sample({ message: '<img src=x onerror=alert(1)>' })]} />)
  expect(html).not.toContain("<img")
  expect(html).toContain("&lt;img")
})

const pause = (over: Partial<ProtectionPause> = {}): ProtectionPause => ({
  id: "pp_" + "1".repeat(32), targetKind: "upstream", targetId: "up_a", targetName: "Copilot A", upstreamId: "up_a", upstreamName: "Copilot A", mode: "pause",
  reason: { windowMinutes: 5, requests: 50, risky: 46, counts: { rate_limited: 46, rejected: 0, auth: 0, upstream: 0, network: 0, other: 0 }, failureRatio: 0.92, topKeys: [], trigger: "ratio", keyShare: null },
  startedAt: AT, endsAt: AT + 30 * 60_000, resolvedAt: null, endedBy: "auto", canResume: true, ...over,
})

test("history shows target, reason, start, end and how each ended", () => {
  const html = renderToStaticMarkup(<PauseHistoryTable pauses={[
    pause(),
    pause({ id: "pp_" + "2".repeat(32), targetKind: "key", targetName: "CI key", endedBy: "owner", resolvedAt: AT + 60_000 }),
    pause({ id: "pp_" + "3".repeat(32), mode: "notify", endedBy: null }),
  ]} />)
  for (const text of ["Target", "Reason", "Started", "Ends / ended", "How it ended", "Upstream", "Copilot A", "API key", "CI key", "46 rate-limit errors in 5 min (92% of requests)",
    "2026-11-17 18:05", "2026-11-17 18:35", "2026-11-17 18:06", "Cooldown ended", "Resumed by owner", "Active", "Warning", "Pause"]) expect(html, text).toContain(text)
  expect(renderToStaticMarkup(<PauseHistoryTable pauses={[]} />)).toContain("No pauses or warnings yet.")
})

test("history times are shown in the display zone, not UTC", () => {
  setDisplayZone("Asia/Shanghai")
  const html = renderToStaticMarkup(<PauseHistoryTable pauses={[pause()]} />)
  expect(html).toContain("2026-11-18 02:05")
})
