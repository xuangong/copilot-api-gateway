import { expect, test } from "bun:test"
import { escapeExitsFullscreen, shouldRestoreFullscreen } from "./fullscreen"

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

test("Escape with nothing above fullscreen exits it", () => {
  expect(escapeExitsFullscreen({ key: "Escape", defaultPrevented: false }, false)).toBe(true)
})

test("an Escape a Radix select or dialog already used (defaultPrevented) stays in fullscreen", () => {
  expect(escapeExitsFullscreen({ key: "Escape", defaultPrevented: true }, false)).toBe(false)
})

test("Escape while an image is zoomed only closes the zoom", () => {
  expect(escapeExitsFullscreen({ key: "Escape", defaultPrevented: false }, true)).toBe(false)
})

test("other keys never exit fullscreen", () => {
  expect(escapeExitsFullscreen({ key: "Enter", defaultPrevented: false }, false)).toBe(false)
  expect(escapeExitsFullscreen({ key: "Esc", defaultPrevented: false }, false)).toBe(false)
})
