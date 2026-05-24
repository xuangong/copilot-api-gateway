import { test, expect, describe } from "bun:test"
import {
  OPTIONAL_FLAGS,
  isKnownFlagId,
  defaultsForUpstream,
  parseFlagOverridesWire,
  resolveEffectiveFlags,
  hasExplicitOverride,
} from "~/flags"

describe("catalog", () => {
  test("isKnownFlagId recognizes catalog ids", () => {
    expect(isKnownFlagId("retry-cyber-policy")).toBe(true)
    expect(isKnownFlagId("nonexistent-flag")).toBe(false)
  })
  test("flag ids are unique", () => {
    const ids = OPTIONAL_FLAGS.map((f) => f.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe("defaultsForUpstream", () => {
  test("copilot defaults include retry-cyber-policy and messages-web-search-shim", () => {
    const defaults = defaultsForUpstream("copilot")
    expect(defaults.has("retry-cyber-policy")).toBe(true)
    expect(defaults.has("messages-web-search-shim")).toBe(true)
    expect(defaults.has("vendor-deepseek")).toBe(false)
  })
  test("azure defaults include messages-web-search-shim only", () => {
    const defaults = defaultsForUpstream("azure")
    expect(defaults.has("messages-web-search-shim")).toBe(true)
    expect(defaults.has("retry-cyber-policy")).toBe(false)
  })
  test("custom has no defaults", () => {
    expect(defaultsForUpstream("custom").size).toBe(0)
  })
  test("memoized — returns same set reference", () => {
    expect(defaultsForUpstream("copilot")).toBe(defaultsForUpstream("copilot"))
  })
})

describe("parseFlagOverridesWire", () => {
  test("accepts valid object and drops unknown keys", () => {
    const parsed = parseFlagOverridesWire({
      "retry-cyber-policy": false,
      "vendor-deepseek": true,
      "unknown-flag": true,
    })
    expect(parsed).toEqual({ "retry-cyber-policy": false, "vendor-deepseek": true })
  })
  test("rejects non-object", () => {
    expect(() => parseFlagOverridesWire([])).toThrow()
    expect(() => parseFlagOverridesWire("x")).toThrow()
    expect(() => parseFlagOverridesWire(null)).toThrow()
  })
  test("rejects non-boolean values", () => {
    expect(() => parseFlagOverridesWire({ "retry-cyber-policy": "yes" })).toThrow()
  })
})

describe("resolveEffectiveFlags", () => {
  const copilotDefaults = defaultsForUpstream("copilot")

  test("provider defaults survive when no overrides", () => {
    const eff = resolveEffectiveFlags(copilotDefaults, [])
    expect(eff.has("retry-cyber-policy")).toBe(true)
  })
  test("upstream layer can disable a default", () => {
    const eff = resolveEffectiveFlags(copilotDefaults, [{ "retry-cyber-policy": false }])
    expect(eff.has("retry-cyber-policy")).toBe(false)
  })
  test("later layer overrides earlier", () => {
    const eff = resolveEffectiveFlags(copilotDefaults, [
      { "vendor-deepseek": true },
      { "vendor-deepseek": false },
    ])
    expect(eff.has("vendor-deepseek")).toBe(false)
  })
  test("upstream-on + deployment-off", () => {
    const eff = resolveEffectiveFlags(new Set(), [
      { "vendor-qwen": true },
      { "vendor-qwen": false },
    ])
    expect(eff.has("vendor-qwen")).toBe(false)
  })
  test("undefined layers skipped", () => {
    const eff = resolveEffectiveFlags(copilotDefaults, [undefined, { "vendor-qwen": true }, undefined])
    expect(eff.has("vendor-qwen")).toBe(true)
    expect(eff.has("retry-cyber-policy")).toBe(true)
  })
})

describe("hasExplicitOverride", () => {
  test("returns true when any layer has the key", () => {
    expect(hasExplicitOverride("vendor-qwen", [{ "vendor-qwen": false }])).toBe(true)
    expect(hasExplicitOverride("vendor-qwen", [undefined, { "vendor-qwen": true }])).toBe(true)
  })
  test("returns false when no layer mentions it", () => {
    expect(hasExplicitOverride("vendor-qwen", [{ "retry-cyber-policy": true }])).toBe(false)
  })
})
