import { expect, test } from "bun:test"
import { formatLokiMirrorDocument, parseLokiMirrorText, type LokiMirrorDocument } from "./loki-mirror"

const doc: LokiMirrorDocument = { version: 1, kind: "loki-mirror", gatewayOrigin: "https://central.example", upstreamId: "up_loki_central",
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

test("origins are normalized like the server and unsafe forms are rejected", () => {
  expect(parseLokiMirrorText(JSON.stringify({ ...doc, gatewayOrigin: "https://central.example/" }))?.gatewayOrigin)
    .toBe("https://central.example")
  expect(parseLokiMirrorText(JSON.stringify({ ...doc, gatewayOrigin: "https://CENTRAL.example" }))?.gatewayOrigin)
    .toBe("https://central.example")
  expect(JSON.parse(formatLokiMirrorDocument({ ...doc, gatewayOrigin: "https://CENTRAL.example/" }, "https://central.example")).gatewayOrigin)
    .toBe("https://central.example")
  for (const gatewayOrigin of ["https://central.example/path", "https://central.example?x=1", "https://central.example/#f",
    "https://user:pw@central.example"]) expect(parseLokiMirrorText(JSON.stringify({ ...doc, gatewayOrigin }))).toBeNull()
  expect(parseLokiMirrorText(JSON.stringify({ ...doc, mirrorId: `lkmid_${"B".repeat(32)}` }))).toBeNull()
  expect(parseLokiMirrorText(JSON.stringify({ ...doc, mirrorSecret: `lkm_${"C".repeat(64)}` }))).toBeNull()
})
