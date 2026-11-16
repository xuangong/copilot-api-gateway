import { expect, test } from "bun:test"
import { notifyConfigurationImported } from "../src/sync/hooks"
import { startDeviceSync } from "../src/sync"
import { createDeviceSyncScheduler } from "../src/sync/scheduler"

function fakeTimers() {
  const handlers = new Map<number, () => void>()
  let next = 1
  return {
    handlers,
    setInterval: (handler: () => void) => { handlers.set(next, handler); return next++ },
    clearInterval: (handle: unknown) => { handlers.delete(handle as number) },
    tick: () => { for (const handler of [...handlers.values()]) handler() },
  }
}
const flush = () => new Promise(resolve => setTimeout(resolve, 0))

test("start syncs once immediately, then on every tick, never overlapping; stop is idempotent", async () => {
  const timers = fakeTimers()
  let runs = 0
  let finish!: () => void
  const scheduler = createDeviceSyncScheduler({ intervalMs: 60_000, setInterval: timers.setInterval, clearInterval: timers.clearInterval,
    run: () => { runs++; return new Promise<void>(resolve => { finish = resolve }) } })
  scheduler.start()
  scheduler.start()
  await flush()
  expect([runs, timers.handlers.size]).toEqual([1, 1])
  timers.tick()
  await flush()
  expect(runs).toBe(1)
  finish()
  await flush()
  timers.tick()
  await flush()
  expect(runs).toBe(2)
  scheduler.stop()
  scheduler.stop()
  expect(timers.handlers.size).toBe(0)
  finish()
})

test("a failing run is swallowed and the next tick still runs", async () => {
  const timers = fakeTimers()
  let runs = 0
  const warn = console.warn
  console.warn = () => {}
  try {
    const scheduler = createDeviceSyncScheduler({ setInterval: timers.setInterval, clearInterval: timers.clearInterval,
      run: async () => { runs++; throw new Error("boom") } })
    scheduler.start()
    await flush()
    timers.tick()
    await flush()
    expect(runs).toBe(2)
    scheduler.stop()
  } finally { console.warn = warn }
})

test("startDeviceSync is a singleton, a configuration import triggers a sync, and stop detaches it", async () => {
  const timers = fakeTimers()
  let runs = 0
  const handle = startDeviceSync({ setInterval: timers.setInterval, clearInterval: timers.clearInterval, run: async () => { runs++ } })
  expect(startDeviceSync({ run: async () => { runs += 100 } })).toBe(handle)
  await flush()
  expect(runs).toBe(1)
  notifyConfigurationImported()
  await flush()
  expect(runs).toBe(2)
  handle.stop()
  notifyConfigurationImported()
  await flush()
  expect(runs).toBe(2)
  expect(timers.handlers.size).toBe(0)
  const again = startDeviceSync({ setInterval: timers.setInterval, clearInterval: timers.clearInterval, run: async () => { runs++ } })
  expect(again).not.toBe(handle)
  again.stop()
})

test("a trigger that arrives while a run is in flight schedules exactly one follow-up run", async () => {
  const timers = fakeTimers()
  let runs = 0
  const finishers: Array<() => void> = []
  const scheduler = createDeviceSyncScheduler({ setInterval: timers.setInterval, clearInterval: timers.clearInterval,
    run: () => { runs++; return new Promise<void>(resolve => { finishers.push(resolve) }) } })
  scheduler.start()
  await flush()
  void scheduler.trigger()
  void scheduler.trigger()
  timers.tick()
  await flush()
  expect(runs).toBe(1)
  finishers[0]!()
  await flush()
  expect(runs).toBe(2)
  finishers[1]!()
  await flush()
  expect(runs).toBe(2)
  scheduler.stop()
})
