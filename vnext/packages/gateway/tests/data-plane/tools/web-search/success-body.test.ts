import { expect, test } from "bun:test"
import { readSuccessfulJson, readSuccessfulText } from "../../../../src/data-plane/tools/web-search/providers/success-body.ts"
import { WebSearchCapacityError } from "../../../../src/data-plane/tools/web-search/capacity.ts"

const response = (chunks: Uint8Array[], headers?: HeadersInit): Response => {
  let index = 0
  const result = new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index++]
      if (chunk === undefined) controller.close()
      else controller.enqueue(chunk)
    },
  }), { headers })
  result.text = () => { throw new Error("unbounded text read") }
  result.json = () => { throw new Error("unbounded JSON read") }
  return result
}
const encode = (text: string) => new TextEncoder().encode(text)

test("successful ingress accepts exact EOF despite deceptive Content-Length and rejects plus one", async () => {
  for (const headers of [undefined, { "content-length": "0" }, { "content-length": "999999999" }]) {
    expect(await readSuccessfulText(response([encode("abcd")], headers), {}, 4)).toBe("abcd")
    await expect(readSuccessfulText(response([encode("abcd"), encode("e")], headers), {}, 4)).rejects.toMatchObject({ category: "responseBodyBytes", limit: 4 })
  }
})

test("successful ingress rejects a whole oversized chunk before debit and does not await cancellation", async () => {
  let debits = 0
  let latched: unknown
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(5)) },
    cancel() { cancelled = true; return new Promise<void>(() => undefined) },
  })
  await expect(readSuccessfulText(new Response(stream), { ingress: {
    responseBodyBytes: 4, assertOpen() {}, debit() { debits++ }, fail(error) { latched = error },
  } })).rejects.toBeInstanceOf(WebSearchCapacityError)
  expect(debits).toBe(0)
  expect(latched).toBeInstanceOf(WebSearchCapacityError)
  expect(cancelled).toBe(true)
  expect(stream.locked).toBe(false)
})

test("successful ingress copies small views, handles tiny chunks and UTF-8 spanning blocks", async () => {
  const backing = encode("a".repeat(100000))
  expect(await readSuccessfulText(response([backing.subarray(0, 3)]), {}, 3)).toBe("aaa")
  const json = JSON.stringify({ text: "a".repeat(16382) + "你🙂好" })
  const bytes = encode(json)
  expect(await readSuccessfulJson(response(Array.from(bytes, byte => Uint8Array.of(byte))))).toEqual(JSON.parse(json))
})

test("successful ingress null body is empty and malformed JSON still consumes ingress", async () => {
  const empty = new Response(null)
  empty.text = () => { throw new Error("unbounded empty read") }
  expect(await readSuccessfulText(empty)).toBe("")
  await expect(readSuccessfulJson(empty)).rejects.toBeInstanceOf(SyntaxError)
  let debit = 0
  await expect(readSuccessfulJson(response([encode("oops")]), { ingress: {
    responseBodyBytes: 4, assertOpen() {}, debit(bytes) { debit += bytes }, fail() { throw new Error("should not latch malformed JSON") },
  } })).rejects.toBeInstanceOf(SyntaxError)
  expect(debit).toBe(4)
})

test("successful ingress cancellation interrupts a noncooperative pending read and releases lock", async () => {
  const controller = new AbortController()
  const stream = new ReadableStream<Uint8Array>({ pull() { return new Promise<void>(() => undefined) }, cancel() { return new Promise<void>(() => undefined) } })
  const result = readSuccessfulText(new Response(stream), { signal: controller.signal })
  controller.abort(new Error("cancelled"))
  await expect(result).rejects.toThrow("cancelled")
  expect(stream.locked).toBe(false)
})

test("successful ingress at the exact limit waits for EOF and owns bytes before later backing mutations", async () => {
  let finish: (() => void) | undefined
  const stream = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(encode("abcd"))
    finish = () => controller.close()
  } })
  let complete = false
  const text = readSuccessfulText(new Response(stream), {}, 4).then(value => { complete = true; return value })
  await new Promise<void>(resolve => setTimeout(resolve, 0))
  expect(complete).toBe(false)
  if (finish === undefined) throw new Error("missing stream controller")
  finish()
  expect(await text).toBe("abcd")
  const backing = encode("abc" + "x".repeat(100000))
  let first = true
  const changing = new ReadableStream<Uint8Array>({ pull(controller) {
    if (first) { first = false; controller.enqueue(backing.subarray(0, 3)) }
    else { backing.fill(0); controller.close() }
  } }, { highWaterMark: 0 })
  expect(await readSuccessfulText(new Response(changing), {}, 3)).toBe("abc")
})
