import { expect, test } from "bun:test"
import { shouldRestoreFullscreen } from "./fullscreen"

test("resuming a fullscreen session restores fullscreen", () => {
  expect(shouldRestoreFullscreen(true, "1")).toBe(true)
})

test("arriving from another tab never opens fullscreen, however it was left", () => {
  // The whole point of the asymmetry: a navigation must not throw an overlay
  // over the page the user was just looking at.
  expect(shouldRestoreFullscreen(false, "1")).toBe(false)
})

test("a session left windowed comes back windowed", () => {
  expect(shouldRestoreFullscreen(true, "0")).toBe(false)
})

test("no stored preference means windowed", () => {
  expect(shouldRestoreFullscreen(true, null)).toBe(false)
})

test("an unrecognised stored value is not treated as truthy", () => {
  // Only the exact "1" counts, so a stale or hand-edited value can't strand
  // someone in an overlay they didn't ask for.
  expect(shouldRestoreFullscreen(true, "true")).toBe(false)
})
