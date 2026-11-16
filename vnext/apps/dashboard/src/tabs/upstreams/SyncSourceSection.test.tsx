import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { SyncSourceView } from "../../api/sync"
import { SyncSourceView as View, type SyncSourceViewProps } from "./SyncSourceSection"

const noop = () => {}
const source = (over: Partial<SyncSourceView> = {}): SyncSourceView => ({ origin: "https://central.example", deviceId: `sdv_${"1".repeat(32)}`,
  status: "active", lastAttemptAt: "2026-11-16T10:01:00.000Z", lastSuccessAt: "2026-11-16T10:00:00.000Z", lastError: null, upstreamCount: 2, ...over })
const view = (over: Partial<SyncSourceViewProps> = {}) => renderToStaticMarkup(<View available loaded source={null} text="" replacing={false}
  busy={false} error="" notice="" onText={noop} onConnect={noop} onToggleReplace={noop} onReplace={noop} onDisconnect={noop} {...over} />)

test("it renders nothing while loading or where device sync does not run", () => {
  expect(view({ loaded: false })).toBe("")
  expect(view({ available: false })).toBe("")
})

test("not connected: a document box and a Connect button that needs text", () => {
  const html = view()
  expect(html).toContain("dash.syncSourceTitle")
  expect(html).toContain("dash.syncSourcePasteHint")
  expect(html).toContain("<textarea")
  expect(html.match(/<button[^>]*\sdisabled=""[^>]*>[^<]*dash\.syncSourceConnect/)).not.toBeNull()
  expect(view({ text: "{}" }).match(/<button[^>]*\sdisabled=""[^>]*>[^<]*dash\.syncSourceConnect/)).toBeNull()
})

test("connected: origin, count, last sync, Replace document and Disconnect, and no secret", () => {
  const html = view({ source: source() })
  for (const key of ["dash.syncSourceFrom", "dash.syncSourceCount", "dash.syncSourceLastSuccess", "dash.syncSourceLastAttempt",
    "dash.syncSourceReplace", "dash.syncSourceDisconnect"]) expect(html).toContain(key)
  expect(html).not.toContain("<textarea")
  expect(html).not.toContain("sds_")
  expect(view({ source: source(), replacing: true })).toContain("<textarea")
})

test("revoked, failing and skipped sources explain themselves", () => {
  const revoked = view({ source: source({ status: "revoked" }) })
  expect(revoked).toContain("dash.syncSourceRevokedNotice")
  expect(revoked).toContain("<textarea")
  expect(view({ source: source({ lastError: "unreachable" }) })).toContain("dash.syncSourceFailingNotice")
  expect(view({ source: source({ lastError: "id_conflict" }) })).toContain("dash.syncSourceSkippedNotice")
  const fine = view({ source: source() })
  for (const key of ["dash.syncSourceRevokedNotice", "dash.syncSourceFailingNotice", "dash.syncSourceSkippedNotice"]) expect(fine).not.toContain(key)
})

test("errors alert and a success notice is a status", () => {
  const html = view({ error: "dash.syncSourceRejected", notice: "dash.syncSourceConnected" })
  expect(html).toContain('role="alert"')
  expect(html).toContain('role="status"')
})
