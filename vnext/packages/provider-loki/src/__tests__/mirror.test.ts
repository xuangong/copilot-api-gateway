import { expect, test } from "bun:test"
import { lokiMirrorDocument, parseLokiMirrorDocument, pullLokiMirror } from "../mirror"

const now = 1_800_000_000_000
const mirrorId = `lkmid_${"b".repeat(32)}`
const mirrorSecret = `lkm_${"c".repeat(64)}`
const doc = lokiMirrorDocument("https://central.example", "up_loki_central", mirrorId, mirrorSecret)
const source = parseLokiMirrorDocument(doc)
const credential = { accessToken: "token", tokenType: "Bearer" as const, expiresAt: now + 3_600_000,
  account: { homeAccountId: "home", tenantId: "11111111-1111-4111-8111-111111111111" } }

test("documents round-trip and reject tampering", () => {
  expect(doc).toEqual({ version: 1, kind: "loki-mirror", gatewayOrigin: "https://central.example",
    upstreamId: "up_loki_central", profileId: "loki-df-v1", mirrorId, mirrorSecret })
  expect(source).toEqual({ kind: "mirror", origin: "https://central.example", upstreamId: "up_loki_central", mirrorId, mirrorSecret })
  for (const bad of [null, [], { ...doc, extra: 1 }, { ...doc, version: 2 }, { ...doc, kind: "pairing" },
    { ...doc, profileId: "other" }, { ...doc, mirrorSecret: `lks_${"c".repeat(64)}` }, { ...doc, gatewayOrigin: "http://x" }]) {
    expect(() => parseLokiMirrorDocument(bad)).toThrow("invalid_mirror_document")
  }
})

test("pull sends the secret as a bearer to the central mirror path without following redirects", async () => {
  let seen: { url: string; init: RequestInit } | undefined
  const result = await pullLokiMirror(source, async (url, init) => {
    seen = { url, init }
    return Response.json({ version: 1, profileId: "loki-df-v1", mirrorId, credential })
  }, now)
  expect(result).toEqual({ kind: "ok", credential })
  expect(seen?.url).toBe("https://central.example/api/loki/mirror/up_loki_central")
  expect(seen?.init.redirect).toBe("manual")
  expect(new Headers(seen?.init.headers).get("authorization")).toBe(`Bearer ${mirrorSecret}`)
})

test("pull classifies central responses", async () => {
  const reply = (response: Response | Error) => pullLokiMirror(source, async () => {
    if (response instanceof Error) throw response
    return response
  }, now)
  expect(await reply(Response.json({ error: { code: "invalid_mirror" } }, { status: 401 }))).toEqual({ kind: "revoked" })
  expect(await reply(Response.json({ error: { code: "credential_unavailable" } }, { status: 503 }))).toEqual({ kind: "unavailable" })
  expect(await reply(Response.json({ error: { code: "temporarily_unavailable" } }, { status: 503 }))).toEqual({ kind: "failed" })
  expect(await reply(new Response(null, { status: 302, headers: { location: "https://evil.example" } }))).toEqual({ kind: "failed" })
  expect(await reply(new Error("network"))).toEqual({ kind: "failed" })
  expect(await reply(Response.json({ version: 1, profileId: "loki-df-v1", mirrorId: "lkmid_" + "e".repeat(32), credential }))).toEqual({ kind: "failed" })
  expect(await reply(Response.json({ version: 1, profileId: "loki-df-v1", mirrorId,
    credential: { ...credential, expiresAt: now + 30_000 } }))).toEqual({ kind: "failed" })
})
