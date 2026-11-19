/**
 * Provider-owned contracts the gateway relies on instead of branching on the
 * provider kind. A new provider package must state them explicitly.
 */
import { afterEach, expect, test } from "bun:test"
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

// ── Conformance: contracts every provider hook must keep, run for every bundled
// plugin (in the spirit of LiteLLM's shared base provider tests and Portkey's
// ProviderConfigs: adding a provider is a checklist, not a copy-paste).

// Every credential-shaped field a provider might read, each holding a marker.
const SECRETS = { apiKey: "LEAK-apiKey", githubToken: "LEAK-githubToken", substrateToken: "LEAK-substrate", token: "LEAK-token", accessToken: "LEAK-access", refreshToken: "LEAK-refresh" }
const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

for (const [kind, plugin] of bundledProviderPlugins()) {
  if (plugin.normalizeConfig) {
    test(`${kind}: normalizeConfig rejects an incomplete config without echoing credentials or mutating input`, () => {
      // Credentials present, every other required field missing.
      const input = { ...SECRETS }
      const before = structuredClone(input)
      let message = ""
      try { plugin.normalizeConfig!(input) } catch (error) { message = error instanceof Error ? error.message : String(error) }
      expect(message).not.toBe("")
      expect(message).not.toContain("LEAK-")
      expect(input).toEqual(before)
    })
  }

  if (plugin.probeConfig) {
    test(`${kind}: probeConfig fails an invalid draft before any request`, async () => {
      let requests = 0
      globalThis.fetch = Object.assign(async () => { requests++; return Response.json({}) }, realFetch)
      await expect(plugin.probeConfig!({ ...SECRETS })).rejects.toThrow()
      expect(requests).toBe(0)
    })
  }

  if (plugin.backup?.verbatimConfig) {
    test(`${kind}: backup.verbatimConfig never carries a credential`, () => {
      expect(JSON.stringify(plugin.backup!.verbatimConfig!({ ...SECRETS }))).not.toContain("LEAK-")
    })
  }

  if (plugin.catalog?.modelEndpoints) {
    test(`${kind}: catalog.modelEndpoints tolerates a minimal model entry`, () => {
      expect(typeof plugin.catalog!.modelEndpoints!({ id: "m" }, ["chat_completions"])).toBe("object")
    })
  }
}
