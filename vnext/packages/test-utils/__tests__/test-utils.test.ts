import { expect, test } from "bun:test"
import { collect, createFetchStub, jsonResponse, readBodyText, recordingFetcher, sseResponse, withMockedFetch } from "../src"

const realFetch = globalThis.fetch
const stubGlobalFetch = createFetchStub()

test("sseResponse frames each event as one data line", async () => {
  const res = sseResponse([{ a: 1 }, "[DONE]"])
  expect(res.headers.get("content-type")).toBe("text/event-stream")
  expect(await readBodyText(res)).toBe('data: {"a":1}\n\ndata: [DONE]\n\n')
})

test("recordingFetcher records method, url, headers and body", async () => {
  const { fetcher, calls } = recordingFetcher(() => jsonResponse({ ok: true }, 201))
  const res = await fetcher("https://x.test/a", { method: "POST", headers: { "x-k": "v" }, body: "hi" })
  expect(res.status).toBe(201)
  expect(calls.map(c => [c.method, c.url, c.headers.get("x-k"), c.body])).toEqual([["POST", "https://x.test/a", "v", "hi"]])
})

test("stubGlobalFetch replaces the global fetch for this test", async () => {
  const { calls } = stubGlobalFetch(() => jsonResponse({ stub: true }))
  expect(await (await fetch("https://x.test/b")).json()).toEqual({ stub: true })
  expect(calls.map(c => c.url)).toEqual(["https://x.test/b"])
})

test("…and the previous test's stub was restored", () => {
  expect(globalThis.fetch).toBe(realFetch)
})

test("withMockedFetch restores the global fetch even when the body throws, and serializes overlap", async () => {
  const order: string[] = []
  await expect(withMockedFetch(() => jsonResponse({}), async () => { throw new Error("boom") })).rejects.toThrow("boom")
  expect(globalThis.fetch).toBe(realFetch)
  await Promise.all([
    withMockedFetch(() => jsonResponse("a"), async () => { order.push(await (await fetch("https://x.test")).json() as string); await Bun.sleep(5); order.push("a-end") }),
    withMockedFetch(() => jsonResponse("b"), async () => { order.push(await (await fetch("https://x.test")).json() as string) }),
  ])
  expect(order).toEqual(["a", "a-end", "b"])
})

test("collect drains an async iterable", async () => {
  async function* gen() { yield 1; yield 2 }
  expect(await collect(gen())).toEqual([1, 2])
})
