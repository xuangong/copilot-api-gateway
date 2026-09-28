import { expect, test } from "bun:test"
import { formatModelsText, parseModelsText } from "./model-text"

test("model editor retains display, ownership and pricing entries through load/save", () => {
  const models = ["simple", { id: "named", name: "Named", ownedBy: "vendor" }, { upstreamModelId: "named", cost: { input: 0.001 } }]
  const text = formatModelsText(models)
  expect(text).not.toContain("undefined")
  expect(parseModelsText(text)).toEqual(models)
})

test("model editor preserves IDs containing line-notation delimiters", () => {
  const models = ["model#variant", { id: "model", name: "Label # one", ownedBy: "vendor" }]
  expect(parseModelsText(formatModelsText(models))).toEqual(models)
})

test("plain model syntax remains supported and invalid JSON cannot become model ids", () => {
  expect(parseModelsText("plain\n named # Display ")).toEqual(["plain", { id: "named", name: "Display" }])
  expect(parseModelsText(" ")).toBeUndefined()
  expect(() => parseModelsText('[{"id":')).toThrow()
  expect(() => parseModelsText('[null]')).toThrow()
  expect(() => parseModelsText('[{"cost":{}}]')).toThrow()
})
