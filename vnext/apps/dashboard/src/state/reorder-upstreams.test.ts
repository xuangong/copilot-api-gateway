import { expect, test } from "bun:test"
import type { UpstreamRecord } from "../api/types"
import { ReorderController, moveUpstream, sortValueForMove } from "./reorder-upstreams"

const row = (id: string, sortOrder: number, ownerId = "mine", enabled = true): UpstreamRecord => ({
  id, ownerId, enabled, sortOrder, name: id, provider: "custom", config: {}, createdAt: id,
} as UpstreamRecord)
const ids = (rows: readonly UpstreamRecord[]) => rows.map((item) => item.id)
const initial = [row("a", 0), row("b", 10), row("c", 20), row("off", 0, "mine", false), row("foreign", 0, "other")]

test("moves source to destination and end while preserving row identity", () => {
  expect(ids(moveUpstream(initial, "a", "c", "mine"))).toEqual(["b", "c", "a", "off", "foreign"])
  expect(ids(moveUpstream(initial, "c", "a", "mine"))).toEqual(["c", "a", "b", "off", "foreign"])
  expect(moveUpstream(initial, "b", "b", "mine")).toBe(initial)
})

test("rejects owner and enabled partition crossing", () => {
  expect(moveUpstream(initial, "b", "foreign", "mine")).toBe(initial)
  expect(moveUpstream(initial, "b", "off", "mine")).toBe(initial)
  expect(moveUpstream(initial, "foreign", "a", "mine")).toBe(initial)
})

test("calculates sort value at both ends and between rows", () => {
  expect(sortValueForMove(initial, "a", "c", "mine")).toBe(21)
  expect(sortValueForMove(initial, "c", "a", "mine")).toBe(-1)
  expect(sortValueForMove(initial, "a", "b", "mine")).toBe(15)
})

test("reindexes tied sort values so a middle drop survives reload", async () => {
  const tied = [row("a", 0), row("b", 0), row("c", 0)]
  const patches: Array<[string, number]> = []
  const controller = new ReorderController(tied, async (id, value) => { patches.push([id, value]) })
  controller.move("a", "b", "mine")
  await controller.idle()
  expect(ids(controller.snapshot())).toEqual(["b", "a", "c"])
  expect(patches).toEqual([["a", 10], ["c", 20]])
})

test("failed old mutation keeps newer local intent and serializes persistence", async () => {
  let failFirst: ((error: Error) => void) | undefined
  const calls: string[] = []
  const controller = new ReorderController(initial, (id) => {
    calls.push(id)
    if (id === "a") return new Promise<void>((_resolve, reject) => { failFirst = reject })
    return Promise.resolve()
  })
  controller.move("a", "c", "mine")
  controller.move("c", "b", "mine")
  expect(calls).toEqual(["a"])
  expect(ids(controller.snapshot())).toEqual(["c", "b", "a", "off", "foreign"])
  controller.replace(initial)
  expect(ids(controller.snapshot())).toEqual(["c", "b", "a", "off", "foreign"])
  failFirst?.(new Error("old failed"))
  await controller.idle()
  expect(calls).toEqual(["a", "c"])
  expect(ids(controller.snapshot())).toEqual(["a", "c", "b", "off", "foreign"])
})

test("queued keyboard move resolves its neighbor after an older failure", async () => {
  let rejectFirst: ((error: Error) => void) | undefined
  const calls: string[] = []
  const controller = new ReorderController(initial, (id) => {
    calls.push(id)
    if (id === "c") return new Promise<void>((_resolve, reject) => { rejectFirst = reject })
    return Promise.resolve()
  })
  controller.moveStep("c", "up", "mine")
  controller.moveStep("b", "up", "mine")
  expect(ids(controller.snapshot())).toEqual(["a", "b", "c", "off", "foreign"])
  rejectFirst?.(new Error("old failed"))
  await controller.idle()
  expect(calls).toEqual(["c", "b"])
  expect(ids(controller.snapshot())).toEqual(["b", "a", "c", "off", "foreign"])
})

test("failed reindex compensation reloads server truth before a queued move", async () => {
  const rows = [row("a", 0), row("b", 0), row("c", 0), row("d", 0)]
  const remote = new Map(rows.map((item) => [item.id, item.sortOrder]))
  const calls: Array<[string, number]> = []
  let rejectHeld: ((error: Error) => void) | undefined
  let loads = 0
  const load = async () => {
    loads += 1
    return rows.map((item) => ({ ...item, sortOrder: remote.get(item.id) ?? 0 }))
      .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt))
  }
  const controller = new ReorderController(rows, async (id, value) => {
    calls.push([id, value])
    if (id === "c" && value === 20) {
      await new Promise<void>((_resolve, reject) => { rejectHeld = reject })
    }
    if (id === "a" && value === 0) throw new Error("compensation failed")
    remote.set(id, value)
  }, () => {}, () => {}, load)
  controller.move("a", "b", "mine")
  controller.move("b", "a", "mine")
  await Promise.resolve()
  rejectHeld?.(new Error("reindex failed"))
  await controller.idle()
  const remoteOrder = await load()
  expect(loads).toBeGreaterThanOrEqual(2)
  expect(ids(controller.snapshot())).toEqual(ids(remoteOrder))
  expect(ids(remoteOrder)).toEqual(["c", "d", "a", "b"])
  expect(calls).toEqual([["a", 10], ["c", 20], ["a", 0], ["b", 11]])
})
