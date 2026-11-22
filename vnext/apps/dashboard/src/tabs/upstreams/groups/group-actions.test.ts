import { afterEach, beforeEach, expect, test } from "bun:test"
import type { UpstreamRecord } from "../../../api/types"
import type { UpstreamGroup } from "../../../api/upstream-groups"
import { installDictionary } from "../../../state/i18n-fixture"
import { memberCandidates, refreshNotice } from "./group-actions"

let restore: () => void = () => {}
beforeEach(() => { restore = installDictionary("en") })
afterEach(() => restore())
const up = (id: string, over: Partial<UpstreamRecord> = {}): UpstreamRecord => ({ id, ownerId: "me", provider: "copilot", name: id, enabled: true, sortOrder: 0, config: {}, disabledPublicModelIds: [], createdAt: "", updatedAt: "", ...over }) as UpstreamRecord
const group = (over: Partial<UpstreamGroup> = {}): UpstreamGroup => ({ id: "ug_1", ownerId: "me", name: "G", enabled: true, sortOrder: 0, memberIds: [], settings: {} as never, createdAt: "", updatedAt: "", ...over })

test("only ungrouped Copilot upstreams of the group's own owner can be added (the server refuses any other owner)", () => {
  const rows = [up("a"), up("b", { groupId: "ug_9" }), up("c", { provider: "custom" }), up("d", { ownerId: "other" }), up("g", { ownerId: "" })]
  expect(memberCandidates(rows, group()).map(u => u.id)).toEqual(["a"])
  expect(memberCandidates(rows, group({ ownerId: "" })).map(u => u.id)).toEqual(["g"])
})

test("the refresh toast says whether GitHub was read, reused a recent read, or failed", () => {
  const t = window.t!
  const NOW = Date.UTC(2026, 10, 22, 12, 0)
  expect(refreshNotice({ status: "read" }, t, NOW)).toEqual({ text: "Read from GitHub", tone: "success" })
  expect(refreshNotice({ status: "reused", lastReadAt: NOW - 5 * 60_000, blockedUntil: NOW + 5 * 60_000 }, t, NOW)).toEqual({ text: "Read 5 minutes ago, reused: the next read is allowed in 5 min", tone: "info" })
  expect(refreshNotice({ status: "reused", lastReadAt: null, blockedUntil: NOW + 3 * 60_000 }, t, NOW)).toEqual({ text: "A recent read is reused: the next read is allowed in 3 min", tone: "info" })
  expect(refreshNotice({ status: "error" }, t, NOW)).toEqual({ text: "Could not read the quota", tone: "error" })
})
