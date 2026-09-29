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

test("Codex catalog advertises installed Responses ingress even when source prefers HTTP", () => {
  const source = { slug: "gpt-5", prefer_websockets: false }
  expect(synthesizeCatalogEntry({ id: "alias" }, source, {}, true).prefer_websockets).toBe(true)
  expect(synthesizeCatalogEntry({ id: "unmatched" }, undefined, {}, true).prefer_websockets).toBe(true)
})

test.each([true, false, undefined])("Codex catalog uses the selected upstream image detail fact %s", (supported) => {
  const source = { slug: "gpt-5", supports_image_detail_original: true, input_modalities: ["text", "image"] }
  const row = { id: "alias", chat: supported === undefined ? undefined : { image_detail_original: supported, modalities: { input: ["text", "image"] } } }
  expect(synthesizeCatalogEntry(row, source).supports_image_detail_original).toBe(supported === true)
})

test("Codex does not advertise original image detail for a text-only upstream", () => {
  const entry = synthesizeCatalogEntry({ id: "text-only", chat: {
    image_detail_original: true, modalities: { input: ["text"] },
  } }, { slug: "gpt-5", input_modalities: ["text", "image"], supports_image_detail_original: true })
  expect(entry.input_modalities).toEqual(["text"])
  expect(entry.supports_image_detail_original).toBe(false)
})
