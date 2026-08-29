import { expect, test } from "bun:test"
import { pruneIndexedState, retractFrom } from "./retract"

const thread = ["u0", "a1", "u2", "a3", "u4", "a5"]

test("retracting a turn drops it and everything after", () => {
  expect(retractFrom(thread, 2)).toEqual(["u0", "a1"])
})

test("retracting the first turn empties the thread", () => {
  expect(retractFrom(thread, 0)).toEqual([])
})

test("retracting the last turn keeps everything before it", () => {
  expect(retractFrom(thread, 5)).toEqual(["u0", "a1", "u2", "a3", "u4"])
})

test("an out-of-range index changes nothing", () => {
  // A stale index from a render that raced a stream must not silently truncate.
  expect(retractFrom(thread, 6)).toBe(thread)
  expect(retractFrom(thread, -1)).toBe(thread)
})

test("index-keyed UI state is cut at the same point", () => {
  expect([...pruneIndexedState(new Set([0, 1, 3, 5]), 2)]).toEqual([0, 1])
})

test("cutting to zero clears index-keyed state entirely", () => {
  expect(pruneIndexedState(new Set([0, 4]), 0).size).toBe(0)
})
