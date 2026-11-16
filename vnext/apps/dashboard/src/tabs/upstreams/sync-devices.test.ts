import { expect, test } from "bun:test"
import type { SyncDevice } from "../../api/sync"
import type { UpstreamRecord } from "../../api/types"
import { canSubmitDevice, initialSelection, selectableUpstreams, syncedCount, toggleSelection } from "./sync-devices"

const row = (over: Partial<UpstreamRecord>): UpstreamRecord => ({ id: "u", provider: "copilot", name: "n", enabled: true, sortOrder: 0, config: {},
  disabledPublicModelIds: [], createdAt: "", updatedAt: "", ownerId: "me", syncable: true, ...over })
const device = (upstreamIds: string[]): SyncDevice => ({ id: "sdv_x", label: "MacBook", upstreamIds, createdAt: "", lastSyncAt: null })

test("the checklist offers the owner's own upstreams and disables rows the server would reject, with the reason", () => {
  const rows = [row({ id: "a" }), row({ id: "b", provider: "custom", syncable: undefined }), row({ id: "c", ownerId: "other" }),
    row({ id: "d", syncable: false, syncBlocked: "synced", syncedFrom: { origin: "https://central.example" } }),
    row({ id: "e", syncedFrom: { origin: null } }), row({ id: "f", syncable: false, syncBlocked: "wire" }),
    row({ id: "g", provider: "custom", syncable: false, syncBlocked: "provider" })]
  expect(selectableUpstreams(rows, "me")).toEqual([
    { id: "a", name: "n", provider: "copilot", syncable: true },
    { id: "b", name: "n", provider: "custom", syncable: false, reason: "provider" },
    { id: "d", name: "n", provider: "copilot", syncable: false, reason: "synced" },
    { id: "e", name: "n", provider: "copilot", syncable: false, reason: "synced" },
    { id: "f", name: "n", provider: "copilot", syncable: false, reason: "wire" },
    { id: "g", name: "n", provider: "custom", syncable: false, reason: "provider" },
  ])
})

test("selection toggles, starts from the still-selectable ids, and counts only live syncable upstreams", () => {
  expect(toggleSelection(["a"], "b")).toEqual(["a", "b"])
  expect(toggleSelection(["a", "b"], "a")).toEqual(["b"])
  const available = selectableUpstreams([row({ id: "a" }), row({ id: "b", provider: "custom", syncable: false })], "me")
  expect(initialSelection(device(["a", "b", "gone"]), available)).toEqual(["a"])
  expect(initialSelection(null, available)).toEqual([])
  expect(syncedCount(device(["a", "b", "gone"]), available)).toBe(1)
})

test("a device needs a trimmed label of at most 64 characters and no request in flight", () => {
  expect(canSubmitDevice("MacBook", false)).toBe(true)
  expect(canSubmitDevice("   ", false)).toBe(false)
  expect(canSubmitDevice("x".repeat(65), false)).toBe(false)
  expect(canSubmitDevice("MacBook", true)).toBe(false)
})
