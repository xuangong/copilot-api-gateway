import { expect, test } from "bun:test"
import { ChartColumn } from "lucide-react"
import { allowedTabIds, buildNavGroups, DEFAULT_TAB, filterNavGroups, locateTab, type NavConfigGroup } from "./navigation"

const t = (key: string) => key
const ids = (groups: ReturnType<typeof buildNavGroups>) => groups.map((g) => [g.id, g.items.map((i) => i.id)])

test("an admin sees every page, grouped observe → models → access → connect", () => {
  expect(ids(buildNavGroups(t, { isAdmin: true }))).toEqual([
    ["observe", ["usage", "latency"]],
    ["models", ["models", "pricing"]],
    ["access", ["keys", "users"]],
    ["connect", ["upstreams", "proxies", "clients"]],
  ])
})

test("a non-admin loses Users and Proxies and nothing else", () => {
  expect(ids(buildNavGroups(t, { isAdmin: false }))).toEqual([
    ["observe", ["usage", "latency"]],
    ["models", ["models", "pricing"]],
    ["access", ["keys"]],
    ["connect", ["upstreams", "clients"]],
  ])
})

test("a group left with no visible page is dropped", () => {
  const config: NavConfigGroup[] = [
    { id: "a", label: "A", items: [{ id: "x", label: "X", icon: ChartColumn, adminOnly: true }] },
    { id: "b", label: "B", items: [{ id: "y", label: "Y", icon: ChartColumn }] },
  ]
  expect(filterNavGroups(config, { isAdmin: false }).map((g) => g.id)).toEqual(["b"])
})

test("labels come from the dictionary keys", () => {
  const [observe] = buildNavGroups(t, { isAdmin: true })
  expect(observe?.label).toBe("dash.nav.groupObserve")
  expect(observe?.items[0]?.label).toBe("dash.usage")
})

test("the default page is Usage, which every viewer can see", () => {
  expect(DEFAULT_TAB).toBe("usage")
  expect(allowedTabIds(buildNavGroups(t, { isAdmin: false }))).toContain(DEFAULT_TAB)
})

test("pages outside the sidebar stay reachable by their old addresses", () => {
  const allowed = allowedTabIds(buildNavGroups(t, { isAdmin: true }))
  for (const id of ["upstreams", "proxies", "users", "keys", "models", "pricing", "usage", "latency", "clients", "agent-remote", "settings"]) {
    expect(allowed).toContain(id)
  }
})

test("a non-admin cannot reach Users or Proxies by address, but keeps Settings and Agent Remote", () => {
  const allowed = allowedTabIds(buildNavGroups(t, { isAdmin: false }))
  expect(allowed).not.toContain("users")
  expect(allowed).not.toContain("proxies")
  expect(allowed).toContain("settings")
  expect(allowed).toContain("agent-remote")
})

test("locateTab names the group for the breadcrumb, and nothing for hidden pages", () => {
  const groups = buildNavGroups(t, { isAdmin: true })
  expect(locateTab(groups, "keys")).toEqual({ group: "dash.nav.groupAccess", page: "dash.apiKeys" })
  expect(locateTab(groups, "settings")).toEqual({ group: null, page: null })
})
