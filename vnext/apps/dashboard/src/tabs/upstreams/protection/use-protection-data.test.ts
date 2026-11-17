import { expect, test } from "bun:test"
import { needsFullLoad } from "./use-protection-data"

test("only the series is refetched when just the range changed", () => {
  expect(needsFullLoad(null, { upstreamId: "a", reloadTick: 0 })).toBe(true)
  expect(needsFullLoad({ upstreamId: "a", reloadTick: 0 }, { upstreamId: "a", reloadTick: 0 })).toBe(false)
  expect(needsFullLoad({ upstreamId: "a", reloadTick: 0 }, { upstreamId: "a", reloadTick: 1 })).toBe(true)
  expect(needsFullLoad({ upstreamId: "a", reloadTick: 0 }, { upstreamId: "b", reloadTick: 0 })).toBe(true)
})
