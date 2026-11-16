import { expect, test } from "bun:test"
import { SyncDocumentError, normalizeHttpsOrigin, parseSyncDocument, parseSyncSnapshot, syncDocument } from "../src/sync/protocol"

const deviceId = `sdv_${"1".repeat(32)}`
const secret = `sds_${"2".repeat(64)}`
const doc = (over: Record<string, unknown> = {}) => ({ ...syncDocument("https://central.example", deviceId, secret), ...over })

test("a sync document round-trips and normalizes its origin", () => {
  expect(parseSyncDocument(doc())).toEqual(syncDocument("https://central.example", deviceId, secret))
  expect(parseSyncDocument(doc({ gatewayOrigin: "https://CENTRAL.example/" })).gatewayOrigin).toBe("https://central.example")
  expect(parseSyncDocument(doc({ gatewayOrigin: "https://central.example:8443" })).gatewayOrigin).toBe("https://central.example:8443")
})

test("documents reject unknown fields, wrong kinds and malformed identifiers", () => {
  const bad: unknown[] = [
    null, [], "text", doc({ extra: 1 }), doc({ version: 2 }), doc({ kind: "loki-mirror" }), doc({ deviceId: "sdv_short" }),
    doc({ deviceId: `sdv_${"G".repeat(32)}` }), doc({ deviceSecret: `lks_${"2".repeat(64)}` }), doc({ deviceSecret: `sds_${"2".repeat(63)}` }),
    doc({ deviceSecret: `sds_${"A".repeat(64)}` }), (() => { const { deviceSecret: _drop, ...rest } = doc(); return rest })(),
  ]
  for (const value of bad) expect(() => parseSyncDocument(value)).toThrow(SyncDocumentError)
})

test("origins must be bare HTTPS origins", () => {
  for (const origin of ["http://central.example", "https://u:p@central.example", "https://central.example/path", "https://central.example/?q=1",
    "https://central.example#f", "https://central.example?x", "not a url", "", " https://central.example", "https://central.example\\x", 7]) {
    expect(normalizeHttpsOrigin(origin)).toBeNull()
    expect(() => parseSyncDocument(doc({ gatewayOrigin: origin }))).toThrow(SyncDocumentError)
  }
})

const entry = (over: Record<string, unknown> = {}) => ({ id: "up_copilot_a", provider: "copilot", name: "Copilot", config: { githubToken: "t" },
  state: null, flagOverrides: { f: true }, disabledPublicModelIds: ["m"], ...over })
const body = (upstreams: unknown[], over: Record<string, unknown> = {}) => JSON.stringify({ version: 1, deviceId, upstreams, ...over })

test("snapshots parse known fields strictly and ignore unknown ones", () => {
  const parsed = parseSyncSnapshot(body([entry(), entry({ id: "up_loki_b", provider: "loki", state: { a: 1 }, future: "ignored" })]), deviceId)
  expect(parsed.upstreams.map(u => u.id)).toEqual(["up_copilot_a", "up_loki_b"])
  expect(parsed.upstreams[1]).toEqual({ id: "up_loki_b", provider: "loki", name: "Copilot", config: { githubToken: "t" },
    state: { a: 1 }, flagOverrides: { f: true }, disabledPublicModelIds: ["m"] })
  expect(parseSyncSnapshot(body([{ ...entry(), state: undefined }]), deviceId).upstreams[0]!.state).toBeNull()
  expect(parseSyncSnapshot(body([]), deviceId).upstreams).toEqual([])
})

test("malformed snapshots are rejected", () => {
  const cases = [
    "not json", "[]", body([], { version: 2 }), body([], { deviceId: `sdv_${"9".repeat(32)}` }), body([entry(), entry()]),
    body([entry({ id: "bad id" })]), body([entry({ id: 5 })]), body([entry({ provider: "Bad Provider" })]), body([entry({ name: "" })]),
    body([entry({ config: [] })]), body([entry({ flagOverrides: { f: "yes" } })]), body([entry({ flagOverrides: [] })]),
    body([entry({ disabledPublicModelIds: [1] })]), body(["x"]), body(Array.from({ length: 257 }, (_, n) => entry({ id: `up_${n}` }))),
  ]
  for (const text of cases) expect(() => parseSyncSnapshot(text, deviceId)).toThrow(SyncDocumentError)
})
