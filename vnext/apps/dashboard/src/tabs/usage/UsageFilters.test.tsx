import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { UsageDimensions, UsageFilters } from "../../state/usage"
import type { SelectOption } from "../../ui/select"
import { UsageFiltersBar, withCurrentOption } from "./UsageFilters"

// No window.t here, so t() returns the key itself; the assertions use keys.

const allKeys: SelectOption = { value: "", label: "All keys" }
const teamKey: SelectOption = { value: "key-1", label: "Team key", badge: "shared" }
const options = [allKeys, teamKey]

describe("withCurrentOption", () => {
  test("leaves the options alone when the value is present", () => {
    expect(withCurrentOption(options, "key-1", "ignored")).toBe(options)
  })

  test("leaves the options alone when the value is empty (all)", () => {
    expect(withCurrentOption(options, "", "ignored")).toBe(options)
  })

  test("inserts a stale value once, right after the leading all option", () => {
    const out = withCurrentOption(options, "key-gone", "key-gone")
    expect(out).toEqual([allKeys, { value: "key-gone", label: "key-gone" }, teamKey])
    // Running it again on its own output does not add a second copy.
    expect(withCurrentOption(out, "key-gone", "key-gone")).toBe(out)
    // The input is not mutated.
    expect(options).toHaveLength(2)
  })

  test("treats incoming model's 'all' token as the leading all option", () => {
    const incoming = [
      { value: "all", label: "All" },
      { value: "model:a", label: "a" },
    ]
    expect(withCurrentOption(incoming, "model:gpt-x", "gpt-x").map((o) => o.value)).toEqual([
      "all",
      "model:gpt-x",
      "model:a",
    ])
  })

  test("puts a stale value first when there is no all option", () => {
    const plain = [{ value: "a", label: "a" }]
    expect(withCurrentOption(plain, "b", "b").map((o) => o.value)).toEqual(["b", "a"])
  })
})

const noFilters: UsageFilters = { user: "", key: "", client: "", model: "", incomingModel: null }

const dimensions: UsageDimensions = {
  keys: [{ id: "key-1", name: "Team key", shared: true }],
  clients: ["claude-code"],
  models: ["gpt-routed"],
  incomingModels: ["gpt-in"],
  users: [{ id: "user-1", name: "Ada" }],
  sharedInScope: false,
}

function render(props: { isAdmin: boolean; filters?: UsageFilters; dimensions?: UsageDimensions }): string {
  return renderToStaticMarkup(
    <UsageFiltersBar
      isAdmin={props.isAdmin}
      filters={props.filters ?? noFilters}
      dimensions={props.dimensions ?? dimensions}
      onChange={() => {}}
      onClear={() => {}}
    />,
  )
}

describe("UsageFiltersBar", () => {
  test("has no user filter for a non-admin", () => {
    const html = render({ isAdmin: false })
    expect(html).not.toContain("dash.user<")
    expect(html).not.toContain("dash.allUsers")
  })

  test("has no user filter for an admin when there are no users", () => {
    const html = render({ isAdmin: true, dimensions: { ...dimensions, users: [] } })
    expect(html).not.toContain("dash.user<")
    expect(html).not.toContain("dash.allUsers")
  })

  test("shows the user filter for an admin when users exist", () => {
    const html = render({ isAdmin: true })
    expect(html).toContain("dash.user<")
    expect(html).toContain("dash.allUsers")
  })

  test("every trigger is labelled by elements present in the markup", () => {
    const html = render({ isAdmin: true })
    const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]))
    const labelledBy = [...html.matchAll(/aria-labelledby="([^"]+)"/g)].map((m) => m[1]!)
    expect(labelledBy).toHaveLength(5)
    for (const value of labelledBy) {
      const refs = value.split(" ")
      // The first reference is the visible field label.
      expect(ids.has(refs[0]!)).toBe(true)
      for (const ref of refs) expect(ids.has(ref)).toBe(true)
    }
  })

  test("clear filters sits before the shared-usage notice, in the row of selects", () => {
    const html = render({
      isAdmin: true,
      filters: { ...noFilters, key: "key-1" },
      dimensions: { ...dimensions, sharedInScope: true },
    })
    const clear = html.indexOf("dash.clearFilters")
    const note = html.indexOf("dash.sharedUsageNote")
    expect(clear).toBeGreaterThan(-1)
    expect(note).toBeGreaterThan(-1)
    expect(clear).toBeLessThan(note)
  })

  test("a stale incoming model shows its bare name, not the encoded value", () => {
    const html = render({ isAdmin: false, filters: { ...noFilters, incomingModel: "gpt-x" } })
    expect(html).toContain(">gpt-x<")
    expect(html).not.toContain("model:gpt-x")
  })
})
