import { expect, test } from "bun:test"
import { formatLokiMirrorDocument, parseLokiMirrorText } from "./loki-mirror"

const doc = { version: 1, kind: "loki-mirror", gatewayOrigin: "https://central.example", upstreamId: "up_loki_central",
  profileId: "loki-df-v1", mirrorId: `lkmid_${"b".repeat(32)}`, mirrorSecret: `lkm_${"c".repeat(64)}` }

test("issued documents format only for this gateway's HTTPS origin", () => {
  expect(JSON.parse(formatLokiMirrorDocument(doc, "https://central.example"))).toEqual(doc)
  expect(() => formatLokiMirrorDocument(doc, "https://other.example")).toThrow()
  expect(() => formatLokiMirrorDocument({ ...doc, mirrorSecret: "lks_x" }, "https://central.example")).toThrow()
})

test("pasted text parses to a document or a null for invalid input", () => {
  expect(parseLokiMirrorText(` ${JSON.stringify(doc)}\n`)).toEqual(doc)
  for (const text of ["", "{", "[]", JSON.stringify({ ...doc, kind: "pairing" }), JSON.stringify({ ...doc, extra: 1 }),
    JSON.stringify({ ...doc, gatewayOrigin: "http://central.example" })]) expect(parseLokiMirrorText(text)).toBeNull()
})
