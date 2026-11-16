import { expect, test } from "bun:test"
import type { SyncDocument } from "../../api/sync"
import { formatSyncDocument, presentIssuedDocument, httpsOrigin, parseSyncDocumentText } from "./sync-document"

const doc: SyncDocument = { version: 1, kind: "gateway-sync", gatewayOrigin: "https://central.example", deviceId: `sdv_${"1".repeat(32)}`,
  deviceSecret: `sds_${"2".repeat(64)}` }

test("a document issued by this gateway formats, and one naming another gateway or carrying a wrong secret does not", () => {
  expect(JSON.parse(formatSyncDocument(doc, "https://central.example"))).toEqual(doc)
  expect(JSON.parse(formatSyncDocument({ ...doc, gatewayOrigin: "https://CENTRAL.example/" }, "https://central.example")).gatewayOrigin).toBe("https://central.example")
  expect(() => formatSyncDocument(doc, "https://other.example")).toThrow()
  expect(() => formatSyncDocument(doc, "http://central.example")).toThrow()
  expect(() => formatSyncDocument({ ...doc, deviceSecret: `lks_${"2".repeat(64)}` }, "https://central.example")).toThrow()
})

test("pasted text parses to a document, or null for anything invalid", () => {
  expect(parseSyncDocumentText(` ${JSON.stringify(doc)}\n`)).toEqual(doc)
  for (const text of ["", "{", "[]", JSON.stringify({ ...doc, kind: "loki-mirror" }), JSON.stringify({ ...doc, extra: 1 }),
    JSON.stringify({ ...doc, version: 2 }), JSON.stringify({ ...doc, deviceId: "sdv_short" }), JSON.stringify({ ...doc, gatewayOrigin: "http://central.example" })]) {
    expect(parseSyncDocumentText(text)).toBeNull()
  }
})

test("origins are normalized like the server and unsafe forms are rejected", () => {
  expect(parseSyncDocumentText(JSON.stringify({ ...doc, gatewayOrigin: "https://central.example/" }))?.gatewayOrigin).toBe("https://central.example")
  for (const gatewayOrigin of ["https://central.example/path", "https://central.example?x=1", "https://central.example/#f", "https://user:pw@central.example", "not a url"]) {
    expect(parseSyncDocumentText(JSON.stringify({ ...doc, gatewayOrigin }))).toBeNull()
    expect(httpsOrigin(gatewayOrigin)).toBeNull()
  }
})

test("an issued document naming another gateway revokes the new device at once", async () => {
  const revoked: string[] = []
  const revoke = async (id: string) => { revoked.push(id); return { devices: [] as string[] } }
  expect(await presentIssuedDocument({ device: { id: "sdv_a" }, document: doc }, "https://central.example", revoke))
    .toEqual({ kind: "shown", text: JSON.stringify(doc, null, 2) })
  expect(revoked).toEqual([])
  expect(await presentIssuedDocument({ device: { id: "sdv_a" }, document: doc }, "https://other.example", revoke))
    .toEqual({ kind: "mismatch", revoked: true, devices: [] })
  expect(revoked).toEqual(["sdv_a"])
  expect(await presentIssuedDocument({ device: { id: "sdv_b" }, document: doc }, "https://other.example", async () => { throw new Error("down") }))
    .toEqual({ kind: "mismatch", revoked: false })
})
