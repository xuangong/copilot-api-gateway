import { expect, test } from "bun:test"
import { withoutLiveModels } from "./upstreams"

test("forgetting one upstream's live preview keeps the others and is a no-op when absent", () => {
  const previews = { a: { ids: ["x"], total: 1 }, b: { ids: ["y"], total: 1 } }
  expect(withoutLiveModels(previews, "a")).toEqual({ b: { ids: ["y"], total: 1 } })
  expect(withoutLiveModels(previews, "missing")).toBe(previews)
  expect(withoutLiveModels(previews, "constructor")).toBe(previews)
})
