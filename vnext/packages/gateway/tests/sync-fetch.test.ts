import { expect, test } from "bun:test"
import { fetchSnapshot } from "../src/sync/fetch"
import { SYNC_FETCH_TIMEOUT_MS, SYNC_MAX_SNAPSHOT_BYTES } from "../src/sync/protocol"

const source = { origin: "https://central.example", deviceId: `sdv_${"1".repeat(32)}`, secret: `sds_${"2".repeat(64)}` }
const body = JSON.stringify({ version: 1, deviceId: source.deviceId, upstreams: [{ id: "up_a", provider: "copilot", name: "A",
  config: { githubToken: "t" }, state: null, flagOverrides: {}, disabledPublicModelIds: [] }] })
const sha256 = (value: string | Uint8Array) => new Bun.CryptoHasher("sha256").update(value).digest("hex")

function recording(response: () => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  return { calls, fetcher: async (url: string, init: RequestInit) => { calls.push({ url, init }); return response() } }
}

test("a 200 is parsed, hashed locally into the ETag, and fetched directly without redirects", async () => {
  const { calls, fetcher } = recording(() => new Response(body, { status: 200, headers: { etag: '"server-says-otherwise"' } }))
  const result = await fetchSnapshot({ ...source, etag: null }, fetcher)
  expect(result).toMatchObject({ kind: "changed", etag: `"${sha256(body)}"` })
  if (result.kind === "changed") expect(result.snapshot.upstreams.map(u => u.id)).toEqual(["up_a"])
  const { url, init } = calls[0]!
  expect(url).toBe("https://central.example/api/sync/snapshot")
  expect(init.method).toBe("GET")
  expect(init.redirect).toBe("manual")
  expect(init.signal).toBeInstanceOf(AbortSignal)
  const headers = new Headers(init.headers)
  expect(headers.get("authorization")).toBe(`Bearer ${source.secret}`)
  expect(headers.has("if-none-match")).toBe(false)
})

test("the stored ETag is sent as If-None-Match and a 304 means nothing changed", async () => {
  const { calls, fetcher } = recording(() => new Response(null, { status: 304 }))
  expect(await fetchSnapshot({ ...source, etag: '"abc"' }, fetcher)).toEqual({ kind: "not_modified" })
  expect(new Headers(calls[0]!.init.headers).get("if-none-match")).toBe('"abc"')
  const withoutEtag = recording(() => new Response(null, { status: 304 }))
  expect(await fetchSnapshot({ ...source, etag: null }, withoutEtag.fetcher)).toEqual({ kind: "failed", code: "bad_response" })
})

test("status codes map to outcomes", async () => {
  const cases: Array<[number, unknown]> = [
    [401, { kind: "revoked" }], [302, { kind: "failed", code: "http_error" }], [403, { kind: "failed", code: "http_error" }],
    [404, { kind: "failed", code: "http_error" }], [500, { kind: "failed", code: "http_error" }], [503, { kind: "failed", code: "http_error" }],
  ]
  for (const [status, expected] of cases) {
    expect(await fetchSnapshot({ ...source, etag: null }, async () => new Response("x", { status }))).toEqual(expected)
  }
  expect(await fetchSnapshot({ ...source, etag: null }, async () => { throw new Error("network down") })).toEqual({ kind: "failed", code: "unreachable" })
})

test("malformed, mismatched and oversized bodies are bad responses", async () => {
  const bad = { kind: "failed", code: "bad_response" }
  const respond = (make: () => Response) => fetchSnapshot({ ...source, etag: null }, async () => make())
  expect(await respond(() => new Response("not json"))).toEqual(bad)
  expect(await respond(() => new Response(body.replace(source.deviceId, `sdv_${"9".repeat(32)}`)))).toEqual(bad)
  expect(await respond(() => new Response(new Uint8Array([0xff, 0xfe, 0xfd])))).toEqual(bad)
  expect(await respond(() => new Response(body, { headers: { "content-length": String(1_048_577) } }))).toEqual(bad)

  let cancelled = false
  const endless = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(65_536)) }, cancel() { cancelled = true } })
  expect(await respond(() => new Response(endless))).toEqual(bad)
  expect(cancelled).toBe(true)
})

test("the timeout is 15 seconds and a timeout or abort while reading the body is unreachable", async () => {
  expect(SYNC_FETCH_TIMEOUT_MS).toBe(15_000)
  for (const name of ["TimeoutError", "AbortError"]) {
    const stalled = new ReadableStream<Uint8Array>({ pull() { throw new DOMException("stalled", name) } })
    expect(await fetchSnapshot({ ...source, etag: null }, async () => new Response(stalled))).toEqual({ kind: "failed", code: "unreachable" })
  }
})

test("a body of exactly 1 MiB is accepted", async () => {
  const head = JSON.stringify({ version: 1, deviceId: source.deviceId, upstreams: [], pad: "" })
  const exact = head.replace('"pad":""', `"pad":"${"x".repeat(SYNC_MAX_SNAPSHOT_BYTES - head.length)}"`)
  expect(new TextEncoder().encode(exact).byteLength).toBe(SYNC_MAX_SNAPSHOT_BYTES)
  expect((await fetchSnapshot({ ...source, etag: null }, async () => new Response(exact))).kind).toBe("changed")
})
