import { expect, test } from "bun:test"
import { catalogFor, type LoadedCatalog } from "./models"

const withModel = (id: string): LoadedCatalog["catalog"] => ({ ...catalogFor(null, undefined).catalog, claudeBig: [id] })

test("nothing is ready before the first load arrives", () => {
  expect(catalogFor(null, "key-a")).toEqual({ ready: false, catalog: catalogFor(null, undefined).catalog })
  expect(catalogFor(null, undefined).ready).toBe(false)
})

test("a catalog is shown only for the key it was loaded for", () => {
  const loaded: LoadedCatalog = { key: "key-a", catalog: withModel("claude-a") }
  expect(catalogFor(loaded, "key-a")).toEqual({ ready: true, catalog: loaded.catalog })
  // Just after a switch to another key: not ready, and not key A's models.
  const other = catalogFor(loaded, "key-b")
  expect(other.ready).toBe(false)
  expect(other.catalog.claudeBig).toEqual([])
})

test("the catalog loaded without a key is ready for no key only", () => {
  const loaded: LoadedCatalog = { key: undefined, catalog: withModel("claude-x") }
  expect(catalogFor(loaded, undefined).ready).toBe(true)
  expect(catalogFor(loaded, "key-a").ready).toBe(false)
})
