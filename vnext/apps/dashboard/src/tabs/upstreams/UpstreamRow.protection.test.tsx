// apps/dashboard/src/tabs/upstreams/UpstreamRow.protection.test.tsx
import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { ProtectionPause } from "../../api/protection"
import type { UpstreamRecord } from "../../api/types"
import { ToastProvider } from "../../state/toast"
import { UpstreamRow } from "./UpstreamRow"

const noop = () => {}
const row: UpstreamRecord = { id: "up_custom", provider: "custom", name: "Custom", enabled: true, sortOrder: 0, config: {}, disabledPublicModelIds: [], createdAt: "", updatedAt: "", syncable: true }
const pause = (mode: "pause" | "notify"): ProtectionPause => ({ id: "pp_" + "1".repeat(32), targetKind: "upstream", targetId: "up_custom", targetName: "Custom", upstreamId: "up_custom", upstreamName: "Custom", mode,
  reason: { windowMinutes: 5, requests: 1, risky: 1, counts: { rate_limited: 1, rejected: 0, auth: 0, upstream: 0, network: 0, other: 0 }, failureRatio: 1, topKeys: [], trigger: "ratio", keyShare: null },
  startedAt: 0, endsAt: 1, resolvedAt: null, endedBy: null, canResume: true })
const render = (extra: Record<string, unknown> = {}) => renderToStaticMarkup(<ToastProvider><UpstreamRow row={row} index={0} total={1} busy={false} models={[]}
  onToggleEnabled={noop} onReorder={noop} onEdit={noop} onDuplicate={noop} onRefreshModels={noop} onRefreshCredential={noop} onReauth={noop} onDelete={noop} {...extra} /></ToastProvider>)

test("the Protection button appears only when asked for, and toggles to Close while open", () => {
  expect(render()).not.toContain("dash.protButton")
  expect(render({ showProtection: true, onToggleProtection: noop })).toContain("dash.protButton")
  expect(render({ showProtection: true, protectionOpen: true, onToggleProtection: noop })).not.toContain("dash.protButton")
})

test("an active pause or warning on the upstream shows a badge", () => {
  expect(render({ pause: pause("pause") })).toContain("dash.protPausedBadge")
  expect(render({ pause: pause("notify") })).toContain("dash.protWarningBadge")
  expect(render()).not.toContain("dash.protPausedBadge")
})
