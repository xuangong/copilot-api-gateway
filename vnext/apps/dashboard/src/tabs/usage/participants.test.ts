import { describe, expect, test } from "bun:test"
import {
  buildDimensions,
  hasSharedKeyInScope,
  indexParticipants,
  isShared,
  usersForKey,
  type ParticipantRow,
} from "./participants"

// Structural stand-in for UsageRow: these functions only ever read keyId and
// keyName, so tests stay free of the token/cost fields.
const row = (keyId: string, keyName?: string) => ({ keyId, ...(keyName ? { keyName } : {}) })

const P = {
  // owner alice, shared with bob + carol
  team: {
    keyId: "k_team",
    ownerId: "u_alice",
    ownerName: "Alice",
    sharedWith: [
      { id: "u_carol", name: "Carol" },
      { id: "u_bob", name: "Bob" },
    ],
  },
  // owner bob, not shared
  solo: { keyId: "k_solo", ownerId: "u_bob", ownerName: "Bob", sharedWith: [] },
  // no owner at all (admin-created key predating ownership)
  orphan: { keyId: "k_orphan", ownerId: null, ownerName: null, sharedWith: [] },
} satisfies Record<string, ParticipantRow>

const ALL: ParticipantRow[] = [P.team, P.solo, P.orphan]

describe("indexParticipants", () => {
  test("keys the rows by keyId", () => {
    const m = indexParticipants(ALL)
    expect(m.get("k_team")?.ownerName).toBe("Alice")
    expect(m.size).toBe(3)
  })

  test("survives an empty response", () => {
    expect(indexParticipants([]).size).toBe(0)
  })
})

describe("isShared", () => {
  test("only keys with at least one assignee are shared", () => {
    const m = indexParticipants(ALL)
    expect(isShared(m, "k_team")).toBe(true)
    expect(isShared(m, "k_solo")).toBe(false)
  })

  // A key with usage but no participants row (non-admin scope, or a key
  // deleted between the two fetches) must not claim to be shared.
  test("an unknown key is not shared", () => {
    expect(isShared(indexParticipants(ALL), "k_missing")).toBe(false)
  })
})

describe("usersForKey", () => {
  test("owner comes first, assignees follow sorted by name", () => {
    expect(usersForKey(indexParticipants(ALL), "k_team")).toEqual([
      { id: "u_alice", name: "Alice" },
      { id: "u_bob", name: "Bob" },
      { id: "u_carol", name: "Carol" },
    ])
  })

  test("an ownerless key yields only its assignees", () => {
    const m = indexParticipants([
      { keyId: "k_x", ownerId: null, ownerName: null, sharedWith: [{ id: "u_bob", name: "Bob" }] },
    ])
    expect(usersForKey(m, "k_x")).toEqual([{ id: "u_bob", name: "Bob" }])
  })

  test("an unknown key yields nobody", () => {
    expect(usersForKey(indexParticipants(ALL), "k_missing")).toEqual([])
  })
})

describe("hasSharedKeyInScope", () => {
  test("true when any key in scope has assignees", () => {
    const m = indexParticipants(ALL)
    expect(hasSharedKeyInScope(m, ["k_solo", "k_team"])).toBe(true)
    expect(hasSharedKeyInScope(m, ["k_solo", "k_orphan"])).toBe(false)
    expect(hasSharedKeyInScope(m, [])).toBe(false)
  })
})

describe("buildDimensions", () => {
  const rows = [row("k_team", "Team"), row("k_solo", "Solo"), row("k_orphan", "Orphan")]
  const base = { rows, participants: indexParticipants(ALL), isAdmin: true }

  test("lists every key that has usage, sorted by name", () => {
    expect(buildDimensions(base).keys.map((k) => k.id)).toEqual(["k_orphan", "k_solo", "k_team"])
  })

  // The point of the feature: a key shared with Bob and Carol puts them in the
  // user list, where before only its owner Alice appeared.
  test("counts everyone a listed key is shared with, not just its owner", () => {
    expect(buildDimensions(base).users).toEqual([
      { id: "u_alice", name: "Alice" },
      { id: "u_bob", name: "Bob" },
      { id: "u_carol", name: "Carol" },
    ])
  })

  test("marks shared keys so the dropdown can badge them", () => {
    const d = buildDimensions(base)
    expect(d.keys.find((k) => k.id === "k_team")?.shared).toBe(true)
    expect(d.keys.find((k) => k.id === "k_solo")?.shared).toBe(false)
  })

  // Both dropdowns stay complete regardless of what is selected: narrowing one
  // by the other would strand the user on their current pick.
  test("a user appears only via keys that actually have usage", () => {
    const d = buildDimensions({ ...base, rows: [row("k_solo", "Solo")] })
    expect(d.keys.map((k) => k.id)).toEqual(["k_solo"])
    expect(d.users).toEqual([{ id: "u_bob", name: "Bob" }])
  })

  test("de-duplicates a user who reaches several keys", () => {
    const d = buildDimensions({
      ...base,
      participants: indexParticipants([
        P.team,
        { keyId: "k_two", ownerId: "u_bob", ownerName: "Bob", sharedWith: [{ id: "u_carol", name: "Carol" }] },
      ]),
      rows: [row("k_team", "Team"), row("k_two", "Two")],
    })
    expect(d.users.map((u) => u.id)).toEqual(["u_alice", "u_bob", "u_carol"])
  })

  // Non-admins have no user filter at all (the server sends them no owners),
  // but their key badges still have to work.
  test("non-admin gets no user list but keeps the key badges", () => {
    const d = buildDimensions({ ...base, isAdmin: false })
    expect(d.users).toEqual([])
    expect(d.keys.find((k) => k.id === "k_team")?.shared).toBe(true)
  })

  test("falls back to a truncated id when the key has no name", () => {
    expect(buildDimensions({ ...base, rows: [row("k_abcdefghijkl")] }).keys[0]!.name).toBe("k_abcdef")
  })

  // Usage can reference a key with no participants row; it must still be
  // selectable rather than silently vanishing from the filter.
  test("keeps keys that have usage but no participants row", () => {
    const d = buildDimensions({ ...base, participants: indexParticipants([]) })
    expect(d.keys.map((k) => k.id)).toEqual(["k_orphan", "k_solo", "k_team"])
    expect(d.users).toEqual([])
  })

  test("sharedInScope is true only when a listed key has assignees", () => {
    expect(buildDimensions(base).sharedInScope).toBe(true)
    expect(buildDimensions({ ...base, rows: [row("k_solo", "Solo")] }).sharedInScope).toBe(false)
  })
})

describe("rowMatchesUser", () => {
  test("a row belongs to the owner and to everyone it is shared with", async () => {
    const { rowMatchesUser } = await import("./participants")
    const m = indexParticipants(ALL)
    expect(rowMatchesUser(m, "k_team", "u_alice")).toBe(true)
    expect(rowMatchesUser(m, "k_team", "u_bob")).toBe(true)
    expect(rowMatchesUser(m, "k_solo", "u_alice")).toBe(false)
    expect(rowMatchesUser(m, "k_missing", "u_alice")).toBe(false)
  })
})

// Grouping usage "by user" has to stop short of naming one person when the key
// is shared: the tables record a key, never who held it.
describe("usageAttribution", () => {
  const m = indexParticipants(ALL)

  test("an unshared key is attributed to its owner", async () => {
    const { usageAttribution } = await import("./participants")
    expect(usageAttribution(m, "k_solo")).toEqual({ id: "u_bob", label: "Bob" })
  })

  test("a shared key names everyone who could have used it", async () => {
    const { usageAttribution } = await import("./participants")
    expect(usageAttribution(m, "k_team")).toEqual({
      id: "shared:u_alice+u_bob+u_carol",
      label: "Alice, Bob, Carol",
    })
  })

  // Two keys shared with the same people are the same ambiguity; splitting
  // them into look-alike series would just add noise.
  test("keys with identical participants share one group", async () => {
    const { usageAttribution } = await import("./participants")
    const two = indexParticipants([
      P.team,
      {
        keyId: "k_other",
        ownerId: "u_carol",
        ownerName: "Carol",
        sharedWith: [{ id: "u_alice", name: "Alice" }, { id: "u_bob", name: "Bob" }],
      },
    ])
    expect(usageAttribution(two, "k_team").id).toBe(usageAttribution(two, "k_other").id)
  })

  test("a key with no participants row falls back to the admin bucket", async () => {
    const { usageAttribution } = await import("./participants")
    expect(usageAttribution(m, "k_missing")).toEqual({ id: "_admin", label: "Admin" })
  })

  test("an ownerless unshared key is the admin bucket too", async () => {
    const { usageAttribution } = await import("./participants")
    expect(usageAttribution(m, "k_orphan")).toEqual({ id: "_admin", label: "Admin" })
  })
})
