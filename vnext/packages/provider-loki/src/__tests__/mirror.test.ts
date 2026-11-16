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
  expect(seen?.init.signal).toBeTruthy()
  expect(new Headers(seen?.init.headers).get("authorization")).toBe(`Bearer ${mirrorSecret}`)
})

test("pull classifies central responses", async () => {
  const reply = (response: Response | Error) => pullLokiMirror(source, async () => {
    if (response instanceof Error) throw response
    return response
  }, now)
  expect(await reply(Response.json({ error: { code: "invalid_mirror" } }, { status: 401 }))).toMatchObject({ kind: "revoked" })
  expect(await reply(Response.json({ error: { code: "credential_unavailable" } }, { status: 503 }))).toMatchObject({ kind: "unavailable" })
  expect(await reply(Response.json({ error: { code: "temporarily_unavailable" } }, { status: 503 }))).toMatchObject({ kind: "failed" })
  expect(await reply(new Response(null, { status: 302, headers: { location: "https://evil.example" } }))).toMatchObject({ kind: "failed" })
  expect(await reply(new Error("network"))).toMatchObject({ kind: "failed" })
  expect(await reply(Response.json({ version: 1, profileId: "loki-df-v1", mirrorId: "lkmid_" + "e".repeat(32), credential }))).toMatchObject({ kind: "failed" })
  expect(await reply(Response.json({ version: 1, profileId: "loki-df-v1", mirrorId,
    credential: { ...credential, expiresAt: now + 30_000 } }))).toMatchObject({ kind: "failed" })
})

test("pull rejects malformed, non-JSON and oversized bodies and never reads a 401 body", async () => {
  const reply = (response: Response) => pullLokiMirror(source, async () => response, now)
  const good = { version: 1, profileId: "loki-df-v1", mirrorId, credential }
  expect(await reply(new Response("not json", { status: 200 }))).toMatchObject({ kind: "failed" })
  expect(await reply(Response.json({ ...good, credential: { ...credential, tokenType: "MAC" } }))).toMatchObject({ kind: "failed" })
  expect(await reply(Response.json({ ...good, credential: { ...credential, extra: 1 } }))).toMatchObject({ kind: "failed" })
  expect(await reply(new Response(JSON.stringify(good), { status: 200, headers: { "content-length": "20000" } }))).toMatchObject({ kind: "failed" })
  expect(await reply(new Response(JSON.stringify({ ...good, pad: "x".repeat(17_000) }), { status: 200 }))).toMatchObject({ kind: "failed" })
  let pulled = false
  const body = new ReadableStream({ pull() { pulled = true; throw new Error("read") } }, { highWaterMark: 0 })
  expect(await reply(new Response(body, { status: 401 }))).toMatchObject({ kind: "revoked" })
  expect(pulled).toBe(false)
})

test("pull stops reading and cancels a body that exceeds the cap without content-length", async () => {
  let cancelled = false
  let chunks = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) { chunks += 1; controller.enqueue(new Uint8Array(4096).fill(120)) },
    cancel() { cancelled = true },
  }, { highWaterMark: 0 })
  const result = await pullLokiMirror(source, async () => new Response(body, { status: 200 }), now)
  expect(result).toEqual({ kind: "failed", status: 200 })
  expect(cancelled).toBe(true)
  expect(chunks).toBeLessThan(10)
})
