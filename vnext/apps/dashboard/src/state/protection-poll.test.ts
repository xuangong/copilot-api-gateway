// apps/dashboard/src/state/protection-poll.test.ts
import { expect, test } from "bun:test"
import { startPolling } from "./protection-poll"

const fakeTimers = () => {
  const ticks: Array<() => void> = []
  const cleared: unknown[] = []
  return {
    ticks, cleared,
    timers: { setInterval: (fn: () => void) => { ticks.push(fn); return ticks.length }, clearInterval: (id: never) => { cleared.push(id) } },
  }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0))

test("loads at once, then on every tick, and stops when told to", async () => {
  const f = fakeTimers()
  let loads = 0
  const stop = startPolling(async () => { loads++ }, 60_000, f.timers)
  expect(loads).toBe(1)
  await settle()
  f.ticks[0]!()
  expect(loads).toBe(2)
  await settle()
  stop()
  expect(f.cleared).toEqual([1])
  f.ticks[0]!()
  expect(loads).toBe(2)
})

test("a load that is still running is not started twice, and a failing load does not stop the polling", async () => {
  const f = fakeTimers()
  let loads = 0
  let release: () => void = () => {}
  startPolling(() => { loads++; return new Promise<void>((resolve, reject) => { release = loads === 1 ? resolve : () => reject(new Error("offline")) }) }, 60_000, f.timers)
  f.ticks[0]!()
  expect(loads).toBe(1)
  release()
  await settle()
  f.ticks[0]!()
  expect(loads).toBe(2)
  release()
  await settle()
  f.ticks[0]!()
  expect(loads).toBe(3)
})

test("ticks while the page is hidden are skipped and one refresh happens when it is shown again", async () => {
  const f = fakeTimers()
  const state = { hidden: false, listener: () => {} }
  const visibility = { hidden: () => state.hidden, subscribe: (l: () => void) => { state.listener = l; return () => {} } }
  let loads = 0
  startPolling(async () => { loads++ }, 60_000, f.timers, visibility)
  await settle()
  state.hidden = true
  f.ticks[0]!(); f.ticks[0]!()
  expect(loads).toBe(1)
  state.hidden = false
  state.listener()
  expect(loads).toBe(2)
})
