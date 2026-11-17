import { expect, test } from "bun:test"
import type { ProtectionPause } from "../api/protection"
import { createProtectionController } from "./protection-controller"

const settle = () => new Promise(resolve => setTimeout(resolve, 0))
const pause = (id: string) => ({ id }) as ProtectionPause
const fakeTimers = () => {
  const ticks: Array<() => void> = []
  const cleared: unknown[] = []
  return { ticks, cleared, timers: { setInterval: (fn: () => void) => { ticks.push(fn); return ticks.length }, clearInterval: (id: never) => { cleared.push(id) } } }
}
const visible = { hidden: () => false, subscribe: () => () => {} }

function setup(over: Partial<Parameters<typeof createProtectionController>[0]> = {}) {
  const f = fakeTimers()
  const seen: string[][] = []
  const results: boolean[] = []
  const pending: string[][] = []
  const controller = createProtectionController({
    fetchActive: async () => ({ pauses: [] }), resumePause: async () => ({ ok: true }),
    onPauses: list => seen.push(list.map(p => p.id)), onPending: ids => pending.push([...ids]), onResumeResult: ok => results.push(ok),
    timers: f.timers, visibility: visible, ...over,
  })
  return { f, seen, results, pending, controller }
}

test("a slow older poll cannot overwrite a newer answer", async () => {
  const releases: Array<() => void> = []
  const answers = [[pause("old")], [pause("new")]]
  let call = 0
  const { controller, seen } = setup({ fetchActive: () => { const mine = answers[call++]!; return new Promise(resolve => releases.push(() => resolve({ pauses: mine }))) } })
  const slow = controller.refresh()
  const fast = controller.refresh()
  releases[1]!(); await fast
  releases[0]!(); await slow
  expect(seen).toEqual([["new"]])
})

test("resume refreshes the list afterwards, and a second click while pending is ignored", async () => {
  let resumes = 0
  let fetches = 0
  let release: () => void = () => {}
  const { controller, results, pending, seen } = setup({
    fetchActive: async () => { fetches++; return { pauses: [] } },
    resumePause: () => { resumes++; return new Promise(resolve => { release = () => resolve({}) }) },
  })
  const first = controller.resume("pp_1")
  expect(await controller.resume("pp_1")).toBe(false)
  release()
  expect(await first).toBe(true)
  expect(resumes).toBe(1)
  expect(fetches).toBe(1)
  expect(seen).toEqual([[]])
  expect(results).toEqual([true])
  expect(pending).toEqual([["pp_1"], []])
})

test("a failed resume is reported and can be retried", async () => {
  const { controller, results } = setup({ resumePause: async () => { throw new Error("no") } })
  expect(await controller.resume("pp_1")).toBe(false)
  expect(await controller.resume("pp_1")).toBe(false)
  expect(results).toEqual([false, false])
})

test("start polls at once and on ticks; stopping (unmount) clears the timer and drops late answers", async () => {
  let release: () => void = () => {}
  let fetches = 0
  const { controller, f, seen } = setup({ fetchActive: () => { fetches++; return new Promise(resolve => { release = () => resolve({ pauses: [pause("late")] }) }) } })
  const stop = controller.start()
  expect(fetches).toBe(1)
  stop()
  expect(f.cleared).toEqual([1])
  release(); await settle()
  expect(seen).toEqual([])
})
