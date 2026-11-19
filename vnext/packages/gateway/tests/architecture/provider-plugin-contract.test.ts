/**
 * Provider-owned contracts the gateway relies on instead of branching on the
 * provider kind. A new provider package must state them explicitly.
 */
import { expect, test } from "bun:test"
import { bundledProviderPlugins } from "../../src/data-plane/providers/registry.ts"

test("every bundled provider declares its dashboard-safe config projection", () => {
  const missing = [...bundledProviderPlugins()].filter(([, plugin]) => typeof plugin.publicConfig !== "function").map(([kind]) => kind)
  expect(missing).toEqual([])
})

test("a projection of an empty config is an object, never the input", () => {
  for (const [kind, plugin] of bundledProviderPlugins()) {
    const input = {}
    const out = plugin.publicConfig!(input)
    expect({ kind, isObject: typeof out === "object" && out !== null, aliased: out === input }).toEqual({ kind, isObject: true, aliased: false })
  }
})
