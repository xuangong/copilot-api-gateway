// apps/dashboard/src/tabs/upstreams/groups/GroupCard.test.tsx
import { afterEach, beforeEach, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { UpstreamGroup } from "../../../api/upstream-groups"
import type { GroupItem } from "../../../state/group-items"
import { installDictionary } from "../../../state/i18n-fixture"
import { GroupCard } from "./GroupCard"

let restore: () => void = () => {}
beforeEach(() => { restore = installDictionary("en") })
afterEach(() => restore())
const group = (over: Partial<UpstreamGroup> = {}): UpstreamGroup => ({ id: "ug_1", ownerId: "me", name: "Pool", enabled: true, sortOrder: 0, memberIds: [], settings: {} as never, createdAt: "", updatedAt: "", ...over })
const item = (g = group(), memberCount = 2): GroupItem => ({ kind: "group", id: g.id, ownerId: g.ownerId, enabled: g.enabled, sortOrder: g.sortOrder, group: g, members: Array.from({ length: memberCount }, (_, i) => ({ id: `m${i}` }) as never) })
const render = (over: Partial<Parameters<typeof GroupCard>[0]> = {}) => renderToStaticMarkup(
  <GroupCard item={item()} index={1} total={3} dragging={false} dropTarget={false} readOnly={false} busy={false}
    onReorder={() => {}} onToggleEnabled={() => {}} onRename={() => {}} onDelete={() => {}} onToggleSettings={() => {}} settingsOpen={false} {...over}>
    <div>members go here</div>
  </GroupCard>)

test("the card names the group, counts members and renders its children", () => {
  const out = render()
  expect(out).toContain("Pool")
  expect(out).toContain("2 members")
  expect(out).toContain("members go here")
  expect(out).toContain("Balancing by projected month-end share")
  expect(out).toContain('aria-label="Reorder group Pool"')
})

test("the state is shown: stopped in a danger badge, overage in a warning, a disabled group says so", () => {
  expect(render({ status: { state: "stopped", group: group(), members: [], attention: [], nowMs: 0 } })).toContain("No member can take new sessions")
  expect(render({ status: { state: "overage", group: group(), members: [], attention: [], nowMs: 0 } })).toContain("Overage: new sessions may use members above the soft line")
  expect(render({ item: item(group({ enabled: false })) })).toContain("Group disabled")
})

test("a group without members shows the hint instead of an empty list", () => {
  const out = renderToStaticMarkup(<GroupCard item={item(group(), 0)} index={0} total={1} dragging={false} dropTarget={false} readOnly={false} busy={false}
    onReorder={() => {}} onToggleEnabled={() => {}} onRename={() => {}} onDelete={() => {}} onToggleSettings={() => {}} settingsOpen={false}><div>kids</div></GroupCard>)
  expect(out).toContain("No members yet. Add a Copilot upstream to balance usage.")
  expect(out).not.toContain("kids")
})

test("attention items name the member and the problem", () => {
  const out = render({ status: { state: "normal", group: group(), nowMs: 0, members: [{ upstreamId: "m0", name: "Alpha" } as never], attention: [{ upstreamId: "m0", kind: "read_failing" }] } })
  expect(out).toContain("Alpha: reads keep failing")
})

test("a read-only viewer gets no controls", () => {
  const out = render({ readOnly: true })
  expect(out).not.toContain("Delete group")
  expect(out).not.toContain("Rename")
})
