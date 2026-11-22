// apps/dashboard/src/state/group-status-controller.test.ts
import { expect, test } from "bun:test"
import type { GroupStatus, UpstreamGroup } from "../api/upstream-groups"
import { createGroupStatusController } from "./group-status-controller"

const group = (id: string, memberIds: string[]): UpstreamGroup => ({ id, memberIds, name: id, ownerId: "me", enabled: true, sortOrder: 0, settings: {} as never, createdAt: "", updatedAt: "" })
const status = (id: string, nowMs = 0) => ({ group: group(id, []), state: "normal", members: [], attention: [], nowMs }) as GroupStatus
const visible = { hidden: () => false, subscribe: () => () => {} }
const fakeTimers = () => { const ticks: Array<() => void> = []; return { ticks, timers: { setInterval: (fn: () => void) => { ticks.push(fn); return ticks.length }, clearInterval: () => {} } } }
const settle = () => new Promise(resolve => setTimeout(resolve, 0))

function setup(over: Partial<Parameters<typeof createGroupStatusController>[0]> = {}) {
  const calls: string[] = []
  const seen: string[][] = []
  const f = fakeTimers()
  let clock = 0 // the server's build time of each answer: later answers are newer
  const controller = createGroupStatusController({
    listGroups: async () => ({ groups: [group("ug_1", ["up_a", "up_b"]), group("ug_2", ["up_c"])] }),
    getStatus: async id => status(id, ++clock),
    liveGroup: async id => { calls.push(id); return status(id, ++clock) },
    onStatuses: statuses => seen.push([...statuses.keys()]),
    timers: f.timers, visibility: visible, ...over,
  })
  return { calls, seen, f, controller }
}

test("a refresh loads the groups and every status; a group whose status fails is left out", async () => {
  const { controller, seen } = setup({ getStatus: async id => { if (id === "ug_2") throw new Error("x"); return status(id) } })
  await controller.refresh()
  expect(seen).toEqual([["ug_1"]])
})

test("a slow older refresh cannot overwrite a newer one", async () => {
  const releases: Array<() => void> = []
  let n = 0
  const { controller, seen } = setup({ listGroups: () => { const mine = n++; return new Promise(resolve => releases.push(() => resolve({ groups: [group(`ug_${mine}`, [])] }))) } })
  const slow = controller.refresh()
  const fast = controller.refresh()
  releases[1]!(); await fast
  releases[0]!(); await slow
  expect(seen.every(keys => keys.join() === "ug_1")).toBe(true) // the group list of the older request never comes back
  expect(seen.length).toBeGreaterThan(0)
})

test("opening the page first delivers the plain status of every group at once, then live answers one group at a time", async () => {
  const statusCalls: string[] = []
  const { controller, seen, calls } = setup({ getStatus: async id => { statusCalls.push(id); return status(id) } })
  await controller.readLive()
  expect(statusCalls).toEqual(["ug_1", "ug_2"])
  expect(calls).toEqual(["ug_1", "ug_2"])
  expect(seen).toEqual([["ug_1", "ug_2"], ["ug_1", "ug_2"], ["ug_1", "ug_2"]]) // plain, then one delivery per live answer (the merged map)
})

test("a group whose live read fails keeps its plain status; one that fails both is left out", async () => {
  const { controller, seen } = setup({
    liveGroup: async () => { throw new Error("floor") },
    getStatus: async id => { if (id === "ug_2") throw new Error("x"); return status(id) },
  })
  await controller.readLive()
  expect(seen).toEqual([["ug_1"]])
})

test("a slow live answer built before a newer refresh does not replace it", async () => {
  let release: () => void = () => {}
  const { controller, seen } = setup({
    liveGroup: id => new Promise<GroupStatus>(resolve => { release = () => resolve(status(id, 1)) }),
    getStatus: async id => status(id, 5),
    listGroups: async () => ({ groups: [group("ug_1", [])] }),
  })
  const live = controller.readLive()
  await settle()
  await controller.refresh()
  const before = seen.length
  release(); await live
  expect(seen.length).toBe(before)
})

test("a refresh during the live read neither cancels the remaining live reads nor discards a collected answer", async () => {
  const liveOrder: string[] = []
  let releaseFirst: () => void = () => {}
  const delivered: Array<ReadonlyMap<string, GroupStatus>> = []
  const { controller } = setup({
    liveGroup: id => { liveOrder.push(id); return id === "ug_1" ? new Promise<GroupStatus>(resolve => { releaseFirst = () => resolve(status(id, 10)) }) : Promise.resolve(status(id, 10)) },
    getStatus: async id => status(id, 5),
    onStatuses: statuses => delivered.push(statuses),
  })
  const live = controller.readLive()
  await settle()
  await controller.refresh() // a member Refresh or a poll tick while ug_1 is still being read
  releaseFirst(); await live
  expect(liveOrder).toEqual(["ug_1", "ug_2"])
  const last = delivered[delivered.length - 1]!
  expect(last.get("ug_1")!.nowMs).toBe(10)
  expect(last.get("ug_2")!.nowMs).toBe(10)
})

test("start reads live once and then only refreshes estimates every minute; stop ends the polling", async () => {
  const { controller, calls, f, seen } = setup()
  const stop = controller.start()
  await settle()
  expect(calls).toEqual(["ug_1", "ug_2"])
  const before = seen.length
  f.ticks[0]!()
  await settle()
  expect(seen.length).toBe(before + 1)
  expect(calls).toHaveLength(2) // polling never reads GitHub
  stop()
})

test("after stop nothing is delivered", async () => {
  const { controller, seen } = setup()
  const stop = controller.start()
  stop()
  await settle()
  expect(seen).toEqual([])
})
