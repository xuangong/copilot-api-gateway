import { describe, expect, test } from "bun:test"
import {
  addMapping,
  buildDestinationChoices,
  deleteMapping,
  initialModelMappingsState,
  isModelMappingsDirty,
  moveMapping,
  validateModelMappings,
} from "./model-mappings-state"

describe("model mapping editor state", () => {
  const server = {
    model_mappings_enabled: true,
    model_mappings: [
      { source: "friendly-opus", destination: "claude-opus-4-6" },
      { source: "fast", destination: "gpt-5" },
    ],
  }

  test("initial state clones server mappings", () => {
    const state = initialModelMappingsState(server)
    state.mappings[0]!.source = "changed"
    expect(server.model_mappings[0]!.source).toBe("friendly-opus")
  })

  test("disabled mappings remain editable", () => {
    const state = initialModelMappingsState({ ...server, model_mappings_enabled: false })
    expect(addMapping(state.mappings)).toHaveLength(3)
  })

  test("adds, deletes, and moves mappings immutably at boundaries", () => {
    const added = addMapping(server.model_mappings)
    expect(added).toEqual([...server.model_mappings, { source: "", destination: "" }])
    expect(added).not.toBe(server.model_mappings)
    expect(deleteMapping(server.model_mappings, -1)).toBe(server.model_mappings)
    expect(deleteMapping(server.model_mappings, 2)).toBe(server.model_mappings)
    expect(moveMapping(server.model_mappings, 0, -1)).toBe(server.model_mappings)
    expect(moveMapping(server.model_mappings, 1, 1)).toBe(server.model_mappings)
    expect(moveMapping(server.model_mappings, 0, 1)).toEqual([
      { source: "fast", destination: "gpt-5" },
      { source: "friendly-opus", destination: "claude-opus-4-6" },
    ])
  })

  test("dirty state includes enablement, contents, and order", () => {
    const initial = initialModelMappingsState(server)
    expect(isModelMappingsDirty(initial, server)).toBe(false)
    expect(isModelMappingsDirty({ ...initial, enabled: false }, server)).toBe(true)
    expect(isModelMappingsDirty({ ...initial, mappings: [{ ...initial.mappings[0]!, source: "alias" }, initial.mappings[1]! ] }, server)).toBe(true)
    expect(isModelMappingsDirty({ ...initial, mappings: [...initial.mappings].reverse() }, server)).toBe(true)
  })

  test("destination choices dedupe ids, sort stably, and retain unavailable saved values", () => {
    const choices = buildDestinationChoices(
      [
        { id: "z-model", upstreams: ["zeta"] },
        { id: "shared", upstreams: ["first"] },
        { id: "a-model", upstreams: ["alpha"] },
        { id: "shared", upstreams: ["second", "first"] },
      ],
      ["missing"],
    )
    expect(choices).toEqual([
      { id: "a-model", upstreams: ["alpha"], unavailable: false },
      { id: "missing", upstreams: [], unavailable: true },
      { id: "shared", upstreams: ["first", "second"], unavailable: false },
      { id: "z-model", upstreams: ["zeta"], unavailable: false },
    ])
  })

  test("accepts free source aliases but rejects unavailable destinations", () => {
    expect(validateModelMappings([{ source: "my private alias", destination: "ready" }], new Set(["ready"]))).toEqual([])
    expect(validateModelMappings([{ source: "source", destination: "missing" }], new Set(["ready"]))).toEqual([
      { index: 0, field: "destination", code: "unavailable" },
    ])
  })

  test("validates blank and exact field length boundaries", () => {
    const available = new Set(["ready", "d".repeat(256)])
    expect(validateModelMappings([{ source: " ", destination: "ready" }], available)).toEqual([
      { index: 0, field: "source", code: "blank" },
    ])
    expect(validateModelMappings([{ source: "s".repeat(256), destination: "d".repeat(256) }], available)).toEqual([])
    expect(validateModelMappings([{ source: "s".repeat(257), destination: "ready" }], available)).toEqual([
      { index: 0, field: "source", code: "too_long" },
    ])
    expect(validateModelMappings([{ source: "s", destination: "d".repeat(257) }], available)).toEqual([
      { index: 0, field: "destination", code: "too_long" },
    ])
  })

  test("validates exactly 100 mappings and rejects 101", () => {
    const rows = Array.from({ length: 100 }, (_, index) => ({ source: `s${index}`, destination: "ready" }))
    expect(validateModelMappings(rows, new Set(["ready"]))).toEqual([])
    expect(validateModelMappings([...rows, { source: "extra", destination: "ready" }], new Set(["ready"]))).toEqual([
      { index: 100, field: "mappings", code: "too_many" },
    ])
  })
})
