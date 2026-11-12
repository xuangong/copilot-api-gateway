import { expect, test } from "bun:test"
import { edgeScrollDelta, trackTouchReorder, type GestureDeps, type GestureEvent, type TouchReorderHandlers } from "./touch-reorder"

test("edgeScrollDelta scrolls up near the top, down near the bottom, faster nearer the edge", () => {
  expect(edgeScrollDelta(300, 0, 600)).toBe(0)
  expect(edgeScrollDelta(0, 0, 600)).toBe(-14)
  expect(edgeScrollDelta(24, 0, 600)).toBe(-7)
  expect(edgeScrollDelta(576, 0, 600)).toBe(7)
  expect(edgeScrollDelta(600, 0, 600)).toBe(14)
  // Past the edge (the finger left the scroller): capped at full speed.
  expect(edgeScrollDelta(-50, 0, 600)).toBe(-14)
  // Measured from the scroller's own top, not the window's.
  expect(edgeScrollDelta(120, 100, 600)).toBe(-9)
})

/**
 * A page without a DOM: rows are 100px bands (a: 0–99, b: 100–199, c: 200–299),
 * events are dispatched by hand, and animation frames run only when asked.
 */
function harness(opts: { accept?: (targetId: string) => boolean; scrolls?: boolean } = {}) {
  const calls: string[] = []
  const listeners = new Map<string, Set<(event: GestureEvent) => void>>()
  const frames = new Map<number, () => void>()
  let nextFrame = 1
  let scrolledRows = false
  const handlers: TouchReorderHandlers = {
    start: (id) => { calls.push(`start ${id}`) },
    over: (id, targetId) => { calls.push(`over ${id}→${targetId}`); return opts.accept?.(targetId) ?? true },
    drop: (id, targetId) => { calls.push(`drop ${id}→${targetId}`) },
    cancel: () => { calls.push("cancel") },
  }
  const deps: GestureDeps = {
    events: {
      addEventListener: (type, listener) => { listeners.set(type, (listeners.get(type) ?? new Set()).add(listener)) },
      removeEventListener: (type, listener) => { listeners.get(type)?.delete(listener) },
    },
    // After an auto-scroll the content has moved by one row under a still finger.
    rowAt: (_x, y) => ["a", "b", "c", "d"][Math.floor(y / 100) + (scrolledRows ? 1 : 0)] ?? null,
    autoScroll: () => {
      if (!opts.scrolls) return false
      scrolledRows = true
      return true
    },
    requestFrame: (callback) => { frames.set(nextFrame, callback); return nextFrame++ },
    cancelFrame: (handle) => { frames.delete(handle) },
  }
  const fire = (type: string, y?: number, pointerId = 1) => {
    for (const listener of [...(listeners.get(type) ?? [])]) listener({ type, pointerId, clientX: 10, clientY: y })
  }
  const runFrames = () => { for (const [handle, callback] of [...frames]) { frames.delete(handle); callback() } }
  const live = () => [...listeners.values()].reduce((n, set) => n + set.size, 0)
  const abort = trackTouchReorder({ pointerId: 1, clientX: 10, clientY: 50 }, "a", handlers, deps)
  return { calls, fire, runFrames, live, frames, abort }
}

test("a tap on the handle is not a drag", () => {
  const h = harness()
  h.fire("pointermove", 53)
  h.fire("pointerup", 53)
  expect(h.calls).toEqual([])
  expect(h.live()).toBe(0)
})

test("a flick drops on the row it reached, even when the lift arrives with the move", () => {
  const h = harness()
  h.fire("pointermove", 250)
  h.fire("pointerup", 250)
  expect(h.calls).toEqual(["start a", "over a→c", "drop a→c"])
  expect(h.live()).toBe(0)
  expect(h.frames.size).toBe(0)
})

test("the drop goes to the last row that accepted it, not to a row that refused", () => {
  const h = harness({ accept: (targetId) => targetId !== "c" })
  h.fire("pointermove", 150)
  h.fire("pointermove", 250)
  h.fire("pointerup", 250)
  expect(h.calls).toEqual(["start a", "over a→b", "over a→c", "drop a→b"])
})

test("abort (Esc) cancels a drag, and the later lift does nothing", () => {
  const h = harness()
  h.fire("pointermove", 150)
  h.abort()
  h.fire("pointerup", 150)
  expect(h.calls).toEqual(["start a", "over a→b", "cancel"])
  expect(h.live()).toBe(0)
  expect(h.frames.size).toBe(0)
})

test("abort before the finger moved far enough, or after the gesture ended, reports nothing", () => {
  const early = harness()
  early.abort()
  expect(early.calls).toEqual([])
  const late = harness()
  late.fire("pointermove", 150)
  late.fire("pointerup", 150)
  late.abort()
  expect(late.calls).toEqual(["start a", "over a→b", "drop a→b"])
})

test("when the browser starts its own drag, the gesture lets go without cancelling it", () => {
  const h = harness()
  h.fire("pointermove", 150)
  h.fire("dragstart")
  // A pen's pointer may never report up again; nothing must be left running.
  expect(h.live()).toBe(0)
  expect(h.frames.size).toBe(0)
  h.fire("pointerup", 250)
  expect(h.calls).toEqual(["start a", "over a→b"])
})

test("pointercancel cancels a drag", () => {
  const h = harness()
  h.fire("pointermove", 150)
  h.fire("pointercancel")
  expect(h.calls).toEqual(["start a", "over a→b", "cancel"])
  expect(h.live()).toBe(0)
})

test("other pointers do not move or end the gesture", () => {
  const h = harness()
  h.fire("pointermove", 250, 2)
  h.fire("pointerup", 250, 2)
  expect(h.calls).toEqual([])
  expect(h.live()).toBe(4)
})

test("auto-scroll re-checks the row under a still finger", () => {
  const h = harness({ scrolls: true })
  h.fire("pointermove", 150)
  h.runFrames()
  h.fire("pointerup", 150)
  expect(h.calls).toEqual(["start a", "over a→b", "over a→c", "drop a→c"])
})
