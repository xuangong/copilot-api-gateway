import { expect, test } from "bun:test"
import { canCreateSource, sourceBadge, startPolling } from "./telemetry-sources"

const now = Date.parse("2026-11-16T12:00:00Z")

test("a source is fresh until strictly more than its threshold has passed, and never-pushed is its own state", () => {
  expect(sourceBadge({ lastPushAt: null, settings: {} }, now)).toBe("never")
  expect(sourceBadge({ lastPushAt: "2026-11-16T10:00:00.000Z", settings: {} }, now)).toBe("fresh")
  expect(sourceBadge({ lastPushAt: "2026-11-16T09:59:59.999Z", settings: {} }, now)).toBe("stale")
  expect(sourceBadge({ lastPushAt: "2026-11-16T09:59:59.999Z", settings: { staleAfterHours: 3 } }, now)).toBe("fresh")
})

test("a name needs 1 to 64 characters after trimming and no request in flight", () => {
  expect(canCreateSource("trojan-vm", false)).toBe(true)
  expect(canCreateSource("   ", false)).toBe(false)
  expect(canCreateSource("x".repeat(65), false)).toBe(false)
  expect(canCreateSource("trojan-vm", true)).toBe(false)
})

function fakeVisibility() {
  const state = { hidden: false, listeners: new Set<() => void>() }
  return {
    state,
    set: (hidden: boolean) => { state.hidden = hidden; for (const listener of [...state.listeners]) listener() },
    visibility: { hidden: () => state.hidden, subscribe: (listener: () => void) => { state.listeners.add(listener); return () => { state.listeners.delete(listener) } } },
  }
}

test("polling runs on the interval and stops when asked", () => {
  const ticks: Array<() => void> = []
  const cleared: unknown[] = []
  const timers = { setInterval: (fn: () => void, ms: number) => { expect(ms).toBe(300_000); ticks.push(fn); return 7 }, clearInterval: (id: unknown) => { cleared.push(id) } }
  let runs = 0
  const stop = startPolling(() => { runs++ }, timers, fakeVisibility().visibility)
  ticks[0]!()
  ticks[0]!()
  expect(runs).toBe(2)
  stop()
  expect(cleared).toEqual([7])
})

test("polling pauses while the page is hidden and refreshes once when it is shown again", () => {
  const ticks: Array<() => void> = []
  const timers = { setInterval: (fn: () => void) => { ticks.push(fn); return 1 }, clearInterval: () => {} }
  const page = fakeVisibility()
  let runs = 0
  startPolling(() => { runs++ }, timers, page.visibility)
  page.set(true)
  ticks[0]!(); ticks[0]!(); ticks[0]!()
  expect(runs).toBe(0)
  page.set(false)
  expect(runs).toBe(1)
  // Showing again without a missed tick does not refresh; the interval resumes as normal.
  page.set(true); page.set(false)
  expect(runs).toBe(1)
  ticks[0]!()
  expect(runs).toBe(2)
})

test("a page shown while still hidden-then-hidden again does not refresh, and stopping removes the visibility listener", () => {
  const ticks: Array<() => void> = []
  const timers = { setInterval: (fn: () => void) => { ticks.push(fn); return 1 }, clearInterval: () => {} }
  const page = fakeVisibility()
  let runs = 0
  const stop = startPolling(() => { runs++ }, timers, page.visibility)
  page.set(true); ticks[0]!(); page.set(true)
  expect(runs).toBe(0)
  stop()
  expect(page.state.listeners.size).toBe(0)
  page.set(false)
  expect(runs).toBe(0)
})
