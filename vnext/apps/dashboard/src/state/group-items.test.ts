// apps/dashboard/src/state/group-items.test.ts
import { expect, test } from "bun:test"
import type { UpstreamRecord } from "../api/types"
import type { UpstreamGroup } from "../api/upstream-groups"
import { applyRowOrder, buildOrderItems, ownerSections, toRows } from "./group-items"

const row = (id: string, sortOrder: number, over: Partial<UpstreamRecord> = {}): UpstreamRecord =>
  ({ id, ownerId: "me", provider: "copilot", name: id, enabled: true, sortOrder, config: {}, disabledPublicModelIds: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "", ...over }) as UpstreamRecord
const group = (id: string, sortOrder: number, over: Partial<UpstreamGroup> = {}): UpstreamGroup =>
  ({ id, ownerId: "me", name: id, enabled: true, sortOrder, memberIds: [], settings: {} as never, createdAt: "2026-01-01T00:00:00Z", updatedAt: "", ...over })

test("a group is one item among ungrouped upstreams; members are not items of their own", () => {
  const items = buildOrderItems(
    [row("u0", 0), row("m1", 50, { groupId: "ug_1" }), row("m2", -5, { groupId: "ug_1" }), row("u1", 10), row("u2", 3)],
    [group("ug_1", 5)],
  )
  expect(items.map(i => `${i.kind}:${i.id}`)).toEqual(["upstream:u0", "upstream:u2", "group:ug_1", "upstream:u1"])
  const g = items.find(i => i.kind === "group")!
  expect(g.kind === "group" && g.members.map(m => m.id)).toEqual(["m1", "m2"]) // members keep no order of their own: stable by creation, then id
})

test("disabled items sort after enabled ones, as the upstream list does", () => {
  const items = buildOrderItems([row("off", 0, { enabled: false }), row("on", 9)], [group("ug_1", 1, { enabled: false })])
  expect(items.map(i => i.id)).toEqual(["on", "off", "ug_1"])
})

test("a member whose group is unknown is shown as an ordinary upstream", () => {
  expect(buildOrderItems([row("m", 0, { groupId: "ug_gone" })], []).map(i => i.kind)).toEqual(["upstream"])
})

test("the reorder rows carry only what ordering needs, and a snapshot order is applied back to the items", () => {
  const items = buildOrderItems([row("a", 0), row("b", 1)], [group("ug_1", 2)])
  expect(toRows(items)).toEqual([
    { id: "a", ownerId: "me", enabled: true, sortOrder: 0 }, { id: "b", ownerId: "me", enabled: true, sortOrder: 1 }, { id: "ug_1", ownerId: "me", enabled: true, sortOrder: 2 },
  ])
  const reordered = applyRowOrder(items, [{ id: "ug_1", sortOrder: 0 }, { id: "a", sortOrder: 1 }])
  expect(reordered.map(i => i.id)).toEqual(["ug_1", "a", "b"]) // items missing from the rows keep their place at the end
})

test("items are sectioned by owner, the viewer's own first, labelled by the Copilot login when there is one", () => {
  const items = buildOrderItems(
    [row("mine", 0, { config: { user: { id: 1, login: "me-login" } } }), row("theirs", 1, { ownerId: "zed", config: { user: { id: 2, login: "alice" } } }), row("shared", 2, { ownerId: "" }), row("m", 3, { groupId: "ug_1", ownerId: "zed", config: { user: { id: 3, login: "bob" } } })],
    [group("ug_1", 4, { ownerId: "zed" })],
  )
  const sections = ownerSections(items, "me", "Global")
  expect(sections.map(s => [s.ownerId, s.label, s.isMine, s.items.map(i => i.id)])).toEqual([
    ["me", "@me-login", true, ["mine"]], ["zed", "@alice", false, ["theirs", "ug_1"]], ["", "Global", false, ["shared"]],
  ])
})
