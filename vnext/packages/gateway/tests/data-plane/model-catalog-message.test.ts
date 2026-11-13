import { expect, test } from "bun:test"
import { MODEL_CATALOG_UNAVAILABLE, modelCatalogUnavailableMessage } from "../../src/data-plane/errors/model-catalog.ts"

// The bare 503 sent operators looking for a broken catalog when the model was
// simply absent from every catalog that loaded. Say which model, and how many
// catalogs failed, without naming upstreams to the caller.
test("the catalog-unavailable message names the model and the number of failed catalogs", () => {
  expect(modelCatalogUnavailableMessage("claude-opus-5.5", 1)).toBe(
    "Model catalog is temporarily unavailable: claude-opus-5.5 is not in any catalog that loaded, and 1 upstream catalog could not be loaded. Please retry later.")
  expect(modelCatalogUnavailableMessage("m", 2)).toContain("2 upstream catalogs could not be loaded")
  expect(modelCatalogUnavailableMessage("m", 0)).toContain("1 upstream catalog could not be loaded")
  // Clients matching the old text by prefix keep working.
  expect(MODEL_CATALOG_UNAVAILABLE.startsWith("Model catalog is temporarily unavailable")).toBe(true)
  expect(modelCatalogUnavailableMessage("m", 2).startsWith("Model catalog is temporarily unavailable")).toBe(true)
})
