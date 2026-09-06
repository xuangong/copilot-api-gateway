import { describe, expect, test } from "bun:test"
import { buildCatalog } from "./models"

describe("model mapping catalog", () => {
  test("advertises every supported Claude combination with its serving upstream", () => {
    const catalog = buildCatalog([
      {
        id: "claude-sonnet-4-6",
        _upstream: "alpha",
        supported_endpoints: ["/v1/messages"],
        available_combinations: [
          { effort: "low" },
          { effort: "medium", context1m: true },
          { effort: "xhigh" },
          { context1m: true },
        ],
      },
      {
        id: "claude-sonnet-4-6",
        _upstream: "beta",
        supported_endpoints: ["/v1/messages"],
        available_combinations: [{ effort: "high", context1m: true }],
      },
    ])

    expect(catalog.mappingDestinations).toEqual([
      { id: "claude-sonnet-4-6", upstreams: ["alpha", "beta"] },
      { id: "claude-sonnet-4-6-1m", upstreams: ["alpha"] },
      { id: "claude-sonnet-4-6-high-1m", upstreams: ["beta"] },
      { id: "claude-sonnet-4-6-low", upstreams: ["alpha"] },
      { id: "claude-sonnet-4-6-low-1m", upstreams: ["alpha"] },
      { id: "claude-sonnet-4-6-medium-1m", upstreams: ["alpha"] },
      { id: "claude-sonnet-4-6-xhigh", upstreams: ["alpha"] },
      { id: "claude-sonnet-4-6-xhigh-1m", upstreams: ["alpha"] },
    ])
  })

  test("deduplicates display model lists when raw upstream rows repeat", () => {
    const catalog = buildCatalog([
      { id: "gpt-5", _upstream: "alpha", supported_endpoints: ["/responses"] },
      { id: "gpt-5", _upstream: "beta", supported_endpoints: ["/responses"] },
    ])
    expect(catalog.codex).toEqual(["gpt-5"])
    expect(catalog.mappingDestinations).toEqual([{ id: "gpt-5", upstreams: ["alpha", "beta"] }])
  })

  test("mapped aliases appear in client pickers without becoming mapping destinations or synthetic variants", () => {
    const catalog = buildCatalog([
      { id: "gpt-5", _upstream: "alpha", supported_endpoints: ["/responses"] },
      { id: "coding", _mapped_to: "gpt-5", _upstream: "alpha", supported_endpoints: ["/responses"] },
      { id: "writing", _mapped_to: "claude-sonnet-4-6", _upstream: "alpha", supported_endpoints: ["/v1/messages"], available_combinations: [{ effort: "high" }, { context1m: true }] },
      { id: "searching", _mapped_to: "gemini-3", _upstream: "alpha" },
    ])
    expect(catalog.codex).toContain("coding")
    expect(catalog.claudeBig).toEqual(["writing"])
    expect(catalog.claudeSmall).toEqual(["writing"])
    expect(catalog.gemini).toEqual(["searching"])
    expect(catalog.byUpstream[0]?.models.map((model) => model.id)).toEqual(["gpt-5", "coding", "writing", "searching"])
    expect(catalog.mappingDestinations).toEqual([{ id: "gpt-5", upstreams: ["alpha"] }])
  })

  test("upstream passthrough choices exclude aliases while client model choices include them", () => {
    const catalog = buildCatalog([
      { id: "gpt-target", _upstream: "alpha", _provider: "custom" },
      { id: "searching", _mapped_to: "gpt-target", _upstream: "alpha", _provider: "custom" },
    ])
    expect(catalog.byUpstream[0]?.models.map((model) => model.id)).toEqual(["gpt-target", "searching"])
    expect(catalog.rawByUpstream).toEqual([{
      upstream: "alpha", provider: "custom", models: [{ id: "gpt-target", name: "gpt-target" }],
    }])
  })
})
