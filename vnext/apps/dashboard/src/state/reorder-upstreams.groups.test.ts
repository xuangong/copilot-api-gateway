// apps/dashboard/src/state/reorder-upstreams.groups.test.ts
import { expect, test } from "bun:test"
import { ReorderController, moveUpstream, partitionPosition, sortValueForMove, type ReorderRow } from "./reorder-upstreams"

const r = (id: string, sortOrder: number, over: Partial<ReorderRow> = {}): ReorderRow => ({ id, ownerId: "me", enabled: true, sortOrder, ...over })
const rows = [r("a", 0), r("ug_1", 10), r("b", 20)]

test("a group row is moved among upstream rows like any other row", () => {
  expect(moveUpstream(rows, "ug_1", "a", "me").map(x => x.id)).toEqual(["ug_1", "a", "b"])
  expect(moveUpstream(rows, "a", "b", "me").map(x => x.id)).toEqual(["ug_1", "b", "a"])
  expect(partitionPosition(rows, "ug_1", "me")).toEqual({ position: 2, total: 3 })
  expect(sortValueForMove(rows, "ug_1", "a", "me")).toBe(-1)
})

test("the controller saves a moved group through the same patch callback, by id", async () => {
  const saved: Array<[string, number]> = []
  const controller = new ReorderController<ReorderRow>(rows, async (id, sortOrder) => { saved.push([id, sortOrder]) })
  expect(controller.move("ug_1", "a", "me")).toBe(true)
  await controller.idle()
  expect(saved).toEqual([["ug_1", -1]])
  expect(controller.snapshot().map(x => x.id)).toEqual(["ug_1", "a", "b"])
})
