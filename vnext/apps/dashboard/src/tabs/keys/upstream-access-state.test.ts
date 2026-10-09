import { expect, test } from "bun:test"
import {
  buildUpstreamAccessRows,
  initialUpstreamAccessDraft,
  isUpstreamAccessDirty,
  moveSelectedUpstream,
  setUpstreamAccessMode,
  setUpstreamSelected,
  upstreamAccessPatch,
} from "./upstream-access-state"

const choices = [
  { id: "up-a", name: "First", provider: "copilot" as const, enabled: true },
  { id: "up-b", name: "Second", provider: "custom" as const, enabled: false },
  { id: "up-c", name: "Third", provider: "azure" as const, enabled: true },
]

test("null and a legacy missing setting inherit while an empty list stays custom", () => {
  for (const input of [{}, { upstream_ids: null }]) {
    expect(initialUpstreamAccessDraft(input).mode).toBe("inherit")
    expect(upstreamAccessPatch(initialUpstreamAccessDraft(input))).toEqual({ upstream_ids: null })
  }
  const empty = initialUpstreamAccessDraft({ upstream_ids: [] })
  expect(empty.mode).toBe("custom")
  expect(upstreamAccessPatch(empty)).toEqual({ upstream_ids: [] })
})

test("snake-case null overrides a camel-case alias and malformed settings stay closed", () => {
  expect(upstreamAccessPatch(initialUpstreamAccessDraft({ upstreamIds: ["up-b", "up-a"] })))
    .toEqual({ upstream_ids: ["up-b", "up-a"] })
  expect(upstreamAccessPatch(initialUpstreamAccessDraft({ upstream_ids: null, upstreamIds: ["up-a"] })))
    .toEqual({ upstream_ids: null })
  expect(upstreamAccessPatch(initialUpstreamAccessDraft({ upstream_ids_invalid: true })))
    .toEqual({ upstream_ids: [] })
})

test("customizing inheritance starts in default order and toggling mode preserves a custom empty draft", () => {
  const custom = setUpstreamAccessMode(initialUpstreamAccessDraft({}), "custom", choices)
  expect(upstreamAccessPatch(custom)).toEqual({ upstream_ids: ["up-a", "up-b", "up-c"] })
  const empty = initialUpstreamAccessDraft({ upstream_ids: [] })
  const inherited = setUpstreamAccessMode(empty, "inherit", choices)
  expect(upstreamAccessPatch(inherited)).toEqual({ upstream_ids: null })
  expect(upstreamAccessPatch(setUpstreamAccessMode(inherited, "custom", choices))).toEqual({ upstream_ids: [] })
})

test("checking appends once and unchecking removes without appending unselected upstreams", () => {
  const original = initialUpstreamAccessDraft({ upstream_ids: ["up-b"] })
  const selected = setUpstreamSelected(original, "up-a", true)
  expect(upstreamAccessPatch(setUpstreamSelected(selected, "up-a", true))).toEqual({ upstream_ids: ["up-b", "up-a"] })
  expect(upstreamAccessPatch(setUpstreamSelected(selected, "up-b", false))).toEqual({ upstream_ids: ["up-a"] })
  expect(upstreamAccessPatch(original)).toEqual({ upstream_ids: ["up-b"] })
})

test("moving selected upstreams changes priority and boundary moves leave order intact", () => {
  const original = initialUpstreamAccessDraft({ upstream_ids: ["up-a", "up-b", "up-c"] })
  expect(upstreamAccessPatch(moveSelectedUpstream(original, 2, -1))).toEqual({ upstream_ids: ["up-a", "up-c", "up-b"] })
  expect(upstreamAccessPatch(moveSelectedUpstream(original, 0, -1))).toEqual({ upstream_ids: ["up-a", "up-b", "up-c"] })
  expect(upstreamAccessPatch(moveSelectedUpstream(original, 2, 1))).toEqual({ upstream_ids: ["up-a", "up-b", "up-c"] })
})

test("choice refresh preserves selected order and removed references with unavailable status", () => {
  const rows = buildUpstreamAccessRows(choices, ["removed", "up-b", "up-a"])
  expect(rows.map((row) => [row.id, row.selected, row.unavailable, row.enabled])).toEqual([
    ["removed", true, true, false],
    ["up-b", true, false, false],
    ["up-a", true, false, true],
    ["up-c", false, false, true],
  ])
  expect(choices.map((choice) => choice.id)).toEqual(["up-a", "up-b", "up-c"])
})

test("cancel recreates the saved order rather than keeping the edited selection", () => {
  const server = { upstream_ids: ["up-b", "up-a"] }
  const edited = setUpstreamSelected(initialUpstreamAccessDraft(server), "up-b", false)
  expect(isUpstreamAccessDirty(edited, server)).toBe(true)
  const canceled = initialUpstreamAccessDraft(server)
  expect(upstreamAccessPatch(canceled)).toEqual({ upstream_ids: ["up-b", "up-a"] })
  expect(isUpstreamAccessDirty(canceled, server)).toBe(false)
})

test("restoring defaults saves null and recognizes empty-to-inherit as a change", () => {
  const server = { upstream_ids: [] }
  const inherited = setUpstreamAccessMode(initialUpstreamAccessDraft(server), "inherit", choices)
  expect(isUpstreamAccessDirty(inherited, server)).toBe(true)
  expect(upstreamAccessPatch(inherited)).toEqual({ upstream_ids: null })
})

test("order changes are dirty and invalid saved settings can be explicitly repaired", () => {
  const server = { upstream_ids: ["up-a", "up-b"] }
  expect(isUpstreamAccessDirty(moveSelectedUpstream(initialUpstreamAccessDraft(server), 0, 1), server)).toBe(true)
  const invalid = { upstream_ids: [], upstream_ids_invalid: true }
  expect(isUpstreamAccessDirty(initialUpstreamAccessDraft(invalid), invalid)).toBe(true)
})
