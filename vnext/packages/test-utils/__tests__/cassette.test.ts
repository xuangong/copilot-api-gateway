import { expect, test } from "bun:test"
import type { Fetcher } from "@vibe-core/upstream"
import { cassetteAgeDays, recordingCassetteFetcher, replayFetcher, SCRUBBED } from "../src"

const upstream: Fetcher = async (input) => {
  const url = String(input instanceof Request ? input.url : input)
  if (url.includes("/fail")) return new Response("nope", { status: 500 })
  if (url.includes("/stream")) return new Response('data: {"delta":"hi","token":"stream-secret"}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } })
  return Response.json({ id: "r1", access_token: "body-secret", nested: { refresh_token: "nested-secret", keep: "visible" } }, { headers: { "set-cookie": "s=cookie-secret", "x-request-id": "rid" } })
}

test("recording keeps 2xx exchanges with credentials scrubbed from URL, body and headers", async () => {
  const rec = recordingCassetteFetcher(upstream, () => new Date("2026-11-19T00:00:00Z"))
  await rec("https://api.test/models?key=query-secret", { headers: { authorization: "Bearer header-secret" } })
  await rec("https://api.test/stream", { method: "POST", body: '{"q":1}' })
  await rec("https://api.test/fail")
  const cassette = rec.cassette()
  const text = JSON.stringify(cassette)
  for (const secret of ["query-secret", "header-secret", "body-secret", "nested-secret", "cookie-secret", "stream-secret"]) expect(text).not.toContain(secret)
  expect(cassette.interactions).toHaveLength(2)
  expect(cassette.interactions[0]!.request.url).toBe(`https://api.test/models?key=${encodeURIComponent(SCRUBBED)}`)
  expect(JSON.parse(cassette.interactions[0]!.response.body).nested.keep).toBe("visible")
  expect(cassette.interactions[0]!.response.headers["x-request-id"]).toBe("rid")
  expect(cassetteAgeDays(cassette, new Date("2026-11-29T00:00:00Z"))).toBe(10)
})

test("replay returns recorded responses in order and refuses anything else", async () => {
  const rec = recordingCassetteFetcher(upstream)
  await rec("https://api.test/stream", { method: "POST", body: '{"q":1}' })
  const replay = replayFetcher(rec.cassette())
  await expect(replay("https://api.test/stream", { method: "POST", body: '{"q":2}' })).rejects.toThrow(/cassette mismatch/)
  const res = await replay("https://api.test/stream", { method: "POST", body: '{"q":1}' })
  expect(await res.text()).toContain('data: {"delta":"hi"')
  expect(replay.remaining()).toBe(0)
  await expect(replay("https://api.test/stream", { method: "POST", body: '{"q":1}' })).rejects.toThrow(/no further interaction/)
})
