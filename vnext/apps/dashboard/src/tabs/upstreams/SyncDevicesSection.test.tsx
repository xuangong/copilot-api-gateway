import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { SyncDevicesView, type SyncDevicesViewProps } from "./SyncDevicesSection"

const noop = () => {}
const upstreams = [{ id: "up_copilot", name: "Copilot", provider: "copilot" as const, syncable: true },
  { id: "up_custom", name: "Custom", provider: "custom" as const, syncable: false, reason: "provider" as const },
  { id: "up_synced", name: "Synced", provider: "copilot" as const, syncable: false, reason: "synced" as const },
  { id: "up_wire", name: "Wire", provider: "copilot" as const, syncable: false, reason: "wire" as const }]
const device = { id: `sdv_${"1".repeat(32)}`, label: "MacBook", upstreamIds: ["up_copilot"], createdAt: "2026-11-16T00:00:00.000Z", lastSyncAt: null }
const view = (over: Partial<SyncDevicesViewProps> = {}) => renderToStaticMarkup(<SyncDevicesView devices={[]} upstreams={upstreams} form={null}
  issued={null} busy={false} error="" copied={false} secureOrigin ownerKnown onNew={noop} onEdit={noop} onLabel={noop} onToggle={noop} onSave={noop}
  onCancel={noop} onRevoke={noop} onCopy={noop} onDownload={noop} {...over} />)

test("with no devices the section explains itself and offers to add one", () => {
  const html = view()
  expect(html).toContain("dash.syncDevicesTitle")
  expect(html).toContain("dash.syncDevicesDescription")
  expect(html).toContain("dash.syncDeviceNone")
  expect(html).toContain("dash.syncDeviceNew")
})

test("a device row shows its label, synced count and last sync with edit and revoke", () => {
  const html = view({ devices: [device, { ...device, id: `sdv_${"2".repeat(32)}`, label: "Desktop", lastSyncAt: "2026-11-16T10:00:00.000Z" }] })
  expect(html).toContain("MacBook")
  expect(html).toContain("Desktop")
  expect(html).toContain("dash.syncDeviceCount")
  expect(html).toContain("dash.syncDeviceLastSync")
  expect(html).toContain("dash.edit")
  expect(html).toContain("dash.syncDeviceRevoke")
})

test("the form lists upstreams, disables unsupported providers and issues or saves", () => {
  const html = view({ form: { id: null, label: "Mac", selected: ["up_copilot"] } })
  const boxes = html.match(/<input[^>]*type="checkbox"[^>]*>/g) ?? []
  expect(boxes).toHaveLength(4)
  expect(boxes[0]).toContain("checked")
  expect(boxes[0]).not.toContain("disabled")
  for (const box of boxes.slice(1)) expect(box).toContain("disabled")
  expect(html.match(/dash\.syncDeviceNotSupported/g)).toHaveLength(1)
  expect(html.match(/dash\.syncDeviceSyncedElsewhere/g)).toHaveLength(1)
  expect(html.match(/dash\.syncDeviceBadName/g)).toHaveLength(1)
  expect(html).toContain("dash.syncDeviceIssue")
  expect(view({ form: { id: device.id, label: "Mac", selected: [] } })).toContain("dash.save")
})

test("an issued document is shown once with copy and download", () => {
  const html = view({ issued: { text: '{ "kind": "gateway-sync" }' } })
  expect(html).toContain("gateway-sync")
  expect(html).toContain("dash.syncDeviceSecretHint")
  expect(html).toContain("dash.syncDeviceCopy")
  expect(html).toContain("dash.syncDeviceDownload")
  expect(view({ issued: { text: "x" }, copied: true })).toContain("dash.syncDeviceCopied")
})

test("plain HTTP warns and cannot issue, and errors show as alerts", () => {
  const html = view({ secureOrigin: false, error: "dash.syncDeviceError" })
  expect(html).toContain("dash.syncDeviceHttpsRequired")
  expect(html).toContain('role="alert"')
  expect(html.match(/<button[^>]*\sdisabled=""[^>]*>[^<]*dash\.syncDeviceNew/)).not.toBeNull()
})

test("Add device waits until the signed-in owner is known", () => {
  expect(view({ ownerKnown: false }).match(/<button[^>]*\sdisabled=""[^>]*>[^<]*dash\.syncDeviceNew/)).not.toBeNull()
  expect(view().match(/<button[^>]*\sdisabled=""[^>]*>[^<]*dash\.syncDeviceNew/)).toBeNull()
})
