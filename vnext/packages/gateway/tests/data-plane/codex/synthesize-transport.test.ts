import { expect, test } from "bun:test"
import { synthesizeCatalogEntry } from "../../../src/data-plane/codex/synthesize.ts"

test("Codex catalog never advertises unavailable gateway WebSockets", () => {
  const baseline = synthesizeCatalogEntry({ id: "custom-model" })
  expect(baseline.prefer_websockets).toBe(false)
  for (const preference of [true, false]) {
    const model = synthesizeCatalogEntry({ id: "alias" }, { ...baseline, prefer_websockets: preference })
    expect(model.prefer_websockets).toBe(false)
    expect(model.slug).toBe("alias")
  }
})
