import { describe, expect, test } from "bun:test"
import {
  addMapping,
  buildDestinationChoices,
  deleteMapping,
  initialModelMappingsState,
  isModelMappingsDirty,
  normalizeModelMappings,
  moveMapping,
  setModelMappingsEnabled,
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
    const editableMapping = state.mappings.at(0)
    expect(editableMapping).toBeDefined()
    if (!editableMapping) throw new Error("test setup requires a mapping")
    editableMapping.source = "changed"
    const serverMapping = server.model_mappings.at(0)
    expect(serverMapping).toBeDefined()
    if (!serverMapping) throw new Error("test setup requires a server mapping")
    expect(serverMapping.source).toBe("friendly-opus")
  })

  test("disabled mappings remain editable", () => {
    const state = initialModelMappingsState({ ...server, model_mappings_enabled: false })
    expect(addMapping(state.mappings)).toHaveLength(3)
  })

  test("header enable transition preserves mappings until save", () => {
    const state = initialModelMappingsState({ ...server, model_mappings_enabled: false })
    const enabled = setModelMappingsEnabled(state, true)
    expect(enabled).toEqual({ enabled: true, mappings: server.model_mappings })
    expect(isModelMappingsDirty(enabled, { ...server, model_mappings_enabled: false })).toBe(true)
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
    const firstMapping = initial.mappings.at(0)
    const secondMapping = initial.mappings.at(1)
    expect(firstMapping).toBeDefined()
    expect(secondMapping).toBeDefined()
    if (!firstMapping || !secondMapping) throw new Error("test setup requires two mappings")
    expect(isModelMappingsDirty({ ...initial, mappings: [{ ...firstMapping, source: "alias" }, secondMapping] }, server)).toBe(true)
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

  test("accepts free source aliases and normalizes whitespace before availability", () => {
    expect(validateModelMappings([{ source: " my private alias ", destination: " ready " }], new Set(["ready"]))).toEqual([])
    expect(validateModelMappings([{ source: "source", destination: "missing" }], new Set(["ready"]))).toEqual([
      { index: 0, field: "destination", code: "unavailable" },
    ])
  })

  test("normalizes mapping fields before saving", () => {
    expect(normalizeModelMappings([{ source: " alias ", destination: " ready " }])).toEqual([
      { source: "alias", destination: "ready" },
    ])
  })

  test("validates blank and exact field length boundaries", () => {
    const available = new Set(["ready", "d".repeat(256)])
    expect(validateModelMappings([{ source: " ", destination: "ready" }], available)).toEqual([
      { index: 0, field: "source", code: "blank" },
    ])
    expect(validateModelMappings([{ source: "s".repeat(256), destination: "d".repeat(256) }], available)).toEqual([])
    expect(validateModelMappings([{ source: ` ${"s".repeat(256)} `, destination: " ready " }], available)).toEqual([])
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
