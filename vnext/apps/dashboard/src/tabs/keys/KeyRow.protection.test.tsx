// apps/dashboard/src/tabs/keys/KeyRow.protection.test.tsx
import { afterEach, beforeEach, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { ProtectionPause } from "../../api/protection"
import type { ApiKeyDetail } from "../../api/keys"
import { installDictionary } from "../../state/i18n-fixture"
import { setDisplayZone } from "../telemetry/telemetry-format"
import { KeyRow } from "./KeyRow"

let restore: () => void = () => {}
beforeEach(() => { setDisplayZone("UTC"); restore = installDictionary("en") })
afterEach(() => { restore(); setDisplayZone(null) })

const key = { id: "key_1", name: "CI key", key: "gw_test_placeholder_1", created_at: "2026-11-01T00:00:00Z", last_used_at: null, owner_id: "u1", owner_name: "Owner", is_owner: true, assignees: [] } as unknown as ApiKeyDetail
const pause: ProtectionPause = {
  id: "pp_" + "1".repeat(32), targetKind: "key", targetId: "key_1", targetName: "CI key", upstreamId: "up_a", upstreamName: "Copilot A", mode: "pause",
  reason: { windowMinutes: 5, requests: 50, risky: 46, counts: { rate_limited: 46, rejected: 0, auth: 0, upstream: 0, network: 0, other: 0 }, failureRatio: 0.92, topKeys: [], trigger: "ratio", keyShare: 1 },
  startedAt: Date.UTC(2026, 10, 17, 12, 0), endsAt: Date.UTC(2026, 10, 17, 18, 40), resolvedAt: null, endedBy: null, canResume: true,
}
const render = (props: Record<string, unknown> = {}) => renderToStaticMarkup(
  <table><tbody><KeyRow row={key} selected={false} canManage busy={false} onSelect={() => {}} onDelete={() => {}} {...props} /></tbody></table>)

test("a paused key shows the badge with the end time and the reason as its tooltip, and a Resume action", () => {
  const html = render({ pause, onResume: () => {} })
  expect(html).toMatch(/Paused until (?:\d{2}-\d{2} )?\d{2}:\d{2}/)
  expect(html).toContain('title="46 rate-limit errors in 5 min (92% of requests) on upstream Copilot A"')
  expect(html).toContain(">Resume<")
})

test("an unpaused key has neither badge nor Resume", () => {
  const plain = render()
  expect(plain).not.toContain("Paused until")
  expect(plain).not.toContain(">Resume<")
})

test("Resume follows the server's canResume, not ownership alone", () => {
  expect(render({ pause: { ...pause, canResume: false }, onResume: () => {} })).toContain("Paused until")
  expect(render({ pause: { ...pause, canResume: false }, onResume: () => {} })).not.toContain(">Resume<")
  expect(render({ pause, onResume: () => {}, row: { ...key, is_owner: false } })).toContain("Paused until")
})

test("Resume is disabled while its request is in flight", () => {
  const button = (html: string) => html.match(/<button[^>]*>Resume<\/button>/)?.[0] ?? ""
  expect(button(render({ pause, onResume: () => {} }))).not.toContain('disabled=""')
  expect(button(render({ pause, onResume: () => {}, resuming: true }))).toContain('disabled=""')
})

test("the time is local and the tooltip drops the upstream when it is hidden from the viewer", () => {
  setDisplayZone("Asia/Shanghai")
  expect(render({ pause })).toMatch(/Paused until (?:11-18 )?02:40/)
  const hidden = render({ pause: { ...pause, upstreamId: "", upstreamName: "" } })
  expect(hidden).toContain('title="46 rate-limit errors in 5 min (92% of requests)"')
})

test("the reason is reachable without hover: a focusable badge described by visually hidden text", () => {
  const html = render({ pause })
  expect(html).toMatch(/<span[^>]*tabindex="0"[^>]*aria-describedby="([^"]+)"/)
  const id = html.match(/aria-describedby="([^"]+)"/)?.[1] ?? ""
  expect(html).toMatch(new RegExp(`<span id="${id.replace(/[:]/g, "\\$&")}" class="sr-only">46 rate-limit errors in 5 min \\(92% of requests\\) on upstream Copilot A</span>`))
})
