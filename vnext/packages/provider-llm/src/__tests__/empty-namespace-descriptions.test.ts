import { expect, test } from "bun:test"
import { fillEmptyNamespaceDescriptions } from "../empty-namespace-descriptions"

test("repairs only empty namespace descriptions in supported Responses inventories without mutating input", () => {
  const untouched = Object.freeze({ type: "namespace", name: "kept", description: "Already present", tools: [] })
  const missing = Object.freeze({ type: "namespace", name: "missing", tools: [] })
  const nested = Object.freeze({ type: "namespace", name: "inner", description: "", tools: Object.freeze([]) })
  const outer = Object.freeze({ type: "namespace", name: "outer", description: "", tools: Object.freeze([nested]) })
  const payload = Object.freeze({
    tools: Object.freeze([untouched, missing, outer, Object.freeze({ type: "function", name: "plain", description: "" })]),
    input: Object.freeze([
      Object.freeze({ type: "additional_tools", tools: Object.freeze([Object.freeze({ type: "namespace", name: "extra", description: "", tools: [] })]) }),
      Object.freeze({ type: "tool_search_output", tools: Object.freeze([Object.freeze({ type: "namespace", name: "found", description: "", tools: [] })]) }),
      Object.freeze({ type: "message", content: Object.freeze([{ type: "namespace", name: "ignored", description: "" }]) }),
    ]),
  })
  const result = fillEmptyNamespaceDescriptions(payload) as Record<string, unknown>
  const tools = result.tools as Array<Record<string, unknown>>
  expect(tools[0]).toBe(untouched)
  expect(tools[1]).toBe(missing)
  expect(tools[2]?.description).toBe("Tools in the outer namespace.")
  expect((tools[2]?.tools as Array<Record<string, unknown>>)[0]?.description).toBe("Tools in the inner namespace.")
  expect(tools[3]?.description).toBe("")
  const input = result.input as Array<Record<string, unknown>>
  expect((input[0]?.tools as Array<Record<string, unknown>>)[0]?.description).toBe("Tools in the extra namespace.")
  expect((input[1]?.tools as Array<Record<string, unknown>>)[0]?.description).toBe("Tools in the found namespace.")
  expect(input[2]).toBe(payload.input[2])
  expect(outer.description).toBe("")
})
