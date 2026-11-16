import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { UpstreamRecord } from "../../api/types"
import { ToastProvider } from "../../state/toast"
import { UpstreamRow } from "./UpstreamRow"

const noop = () => {}
const copilot: UpstreamRecord = { id: "up_copilot_s", provider: "copilot", name: "Copilot", enabled: true, sortOrder: 0,
  config: { user: { id: 1, login: "octo" } }, disabledPublicModelIds: [], createdAt: "", updatedAt: "", syncable: true }
const render = (row: UpstreamRecord) => renderToStaticMarkup(<ToastProvider><UpstreamRow row={row} index={1} total={3} busy={false} models={[]} showProxy
  onToggleEnabled={noop} onReorder={noop} onEdit={noop} onDuplicate={noop} onRefreshModels={noop} onRefreshCredential={noop} onReauth={noop} onDelete={noop} />
</ToastProvider>)

test("a synced row shows where it comes from and keeps only enable, reorder and proxy settings", () => {
  const html = render({ ...copilot, syncedFrom: { origin: "https://central.example" } })
  expect(html).toContain("dash.syncedBadge")
  expect(html).toContain("dash.syncedHint")
  expect(html).toContain("dash.moveUp")
  expect(html).toContain("dash.moveDown")
  expect(html).toContain("dash.reorderUpstreamHandle")
  expect(html).toContain("dash.proxyBtn")
  const toggle = html.match(/<input[^>]*role="switch"[^>]*>/)?.[0] ?? ""
  expect(toggle).not.toContain("disabled")
  for (const removed of ["dash.edit", "dash.duplicateUpstream", "dash.refetchModelsLabel", "dash.codexRefreshCredential", "dash.reauthBtn", "dash.signOutBtn", "dash.delete"]) {
    expect(html, removed).not.toContain(removed)
  }
})

test("a synced row whose source is gone still says it is synced", () => {
  const html = render({ ...copilot, syncedFrom: { origin: null } })
  expect(html).toContain("dash.syncedBadgeUnknown")
})

test("an ordinary row keeps its full set of actions", () => {
  const html = render(copilot)
  expect(html).not.toContain("dash.syncedBadge")
  for (const kept of ["dash.edit", "dash.refetchModelsLabel", "dash.reauthBtn", "dash.signOutBtn", "dash.proxyBtn"]) expect(html, kept).toContain(kept)
})

test("a synced Loki row describes its token as coming from the central gateway", () => {
  const loki: UpstreamRecord = { ...copilot, id: "up_loki_s", provider: "loki", name: "Loki", config: {}, syncedFrom: { origin: "https://central.example" },
    lokiStatus: { assistantStatus: "authorized", tokenStatus: "expired", expiresAt: null, updatedAt: null } }
  expect(render(loki)).toContain("dash.syncedLokiExpired")
  expect(render({ ...loki, syncedFrom: undefined })).toContain("dash.lokiExpired")
})
