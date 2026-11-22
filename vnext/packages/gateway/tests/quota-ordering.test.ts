// packages/gateway/tests/quota-ordering.test.ts
import { expect, test } from "bun:test"
import { orderUpstreamsForRouting } from "../src/quota-balance/ordering"
import type { GroupDirectory } from "../src/quota-balance/directory"
import { DEFAULT_GROUP_SETTINGS, type UpstreamGroup } from "../src/repo/quota-balance"

const up = (id: string, sortOrder: number, createdAt = "2026-01-01T00:00:00Z") => ({ id, sortOrder, createdAt })
const group = (id: string, sortOrder: number, createdAt = "2026-01-01T00:00:00Z"): UpstreamGroup =>
  ({ id, ownerId: "o", name: id, enabled: true, sortOrder, settings: DEFAULT_GROUP_SETTINGS, createdAt, updatedAt: createdAt })
const directory = (groups: UpstreamGroup[], members: Record<string, string>): GroupDirectory =>
  ({ groups: new Map(groups.map(g => [g.id, g])), memberOf: new Map(Object.entries(members)) })

test("without groups the order is sort_order, created_at, id as before", () => {
  const list = [up("b", 1), up("a", 1), up("c", 0), up("d", 1, "2025-01-01T00:00:00Z")]
  expect(orderUpstreamsForRouting(list, directory([], {})).map(u => u.id)).toEqual(["c", "d", "a", "b"])
})

test("a group takes its own place among ungrouped upstreams; members stay together and ignore their own sort_order", () => {
  const g = group("ug_" + "1".repeat(32), 5)
  const list = [up("u0", 0), up("m1", 100, "2026-02-01T00:00:00Z"), up("m2", -50, "2026-01-01T00:00:00Z"), up("u1", 10), up("u2", 3)]
  const ordered = orderUpstreamsForRouting(list, directory([g], { m1: g.id, m2: g.id })).map(u => u.id)
  expect(ordered).toEqual(["u0", "u2", "m2", "m1", "u1"])
})

test("two groups and ties: the item key is (sort_order, created_at, id) of the group or the ungrouped upstream", () => {
  const g1 = group("ug_" + "1".repeat(32), 2, "2026-03-01T00:00:00Z")
  const g2 = group("ug_" + "2".repeat(32), 2, "2026-02-01T00:00:00Z")
  const list = [up("x", 2, "2026-02-15T00:00:00Z"), up("a1", 9), up("b1", 9)]
  const ordered = orderUpstreamsForRouting(list, directory([g1, g2], { a1: g1.id, b1: g2.id })).map(u => u.id)
  expect(ordered).toEqual(["b1", "x", "a1"])
})

test("a membership that points at an unknown group is ignored", () => {
  const list = [up("a", 1), up("b", 0)]
  expect(orderUpstreamsForRouting(list, directory([], { a: "ug_" + "9".repeat(32) })).map(u => u.id)).toEqual(["b", "a"])
})
