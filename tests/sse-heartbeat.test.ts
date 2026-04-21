// tests/sse-heartbeat.test.ts
import { test, expect } from "bun:test"
import { createIdleHeartbeatStream } from "~/lib/sse-heartbeat"

const enc = new TextEncoder()
const dec = new TextDecoder()

async function collect(s: ReadableStream<Uint8Array>): Promise<string> {
  const reader = s.getReader()
  let out = ""
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    out += dec.decode(value)
  }
  return out
}

test("passes upstream chunks through unchanged when no idle gap", async () => {
  const upstream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc.encode("data: a\n\n"))
      c.enqueue(enc.encode("data: b\n\n"))
      c.close()
    },
  })
  const out = createIdleHeartbeatStream(upstream, {
    intervalMs: 1_000,
    heartbeat: enc.encode(": ping\n\n"),
  })
  expect(await collect(out)).toBe("data: a\n\ndata: b\n\n")
})
test("injects heartbeat when upstream is idle longer than intervalMs", async () => {
  const upstream = new ReadableStream<Uint8Array>({
    async start(c) {
      c.enqueue(enc.encode("data: first\n\n"))
      // idle gap > 2 * intervalMs
      await new Promise((r) => setTimeout(r, 250))
      c.enqueue(enc.encode("data: last\n\n"))
      c.close()
    },
  })
  const out = createIdleHeartbeatStream(upstream, {
    intervalMs: 100,
    heartbeat: enc.encode(": ping\n\n"),
  })
  const text = await collect(out)
  // first + at least one heartbeat + last
  expect(text).toContain("data: first\n\n")
  expect(text).toContain(": ping\n\n")
  expect(text).toContain("data: last\n\n")
  // heartbeats must come between first and last, not after last
  const lastIdx = text.indexOf("data: last")
  const pingIdx = text.indexOf(": ping")
  expect(pingIdx).toBeGreaterThan(text.indexOf("data: first"))
  expect(pingIdx).toBeLessThan(lastIdx)
})

test("stops heartbeats once upstream closes", async () => {
  const upstream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc.encode("data: only\n\n"))
      c.close()
    },
  })
  const out = createIdleHeartbeatStream(upstream, {
    intervalMs: 50,
    heartbeat: enc.encode(": ping\n\n"),
  })
  // wait well past several intervalMs
  await new Promise((r) => setTimeout(r, 300))
  const text = await collect(out)
  // only the single chunk; no heartbeat fired after close
  expect(text).toBe("data: only\n\n")
})

test("propagates upstream error to downstream", async () => {
  const upstream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc.encode("data: x\n\n"))
      // Use queueMicrotask to avoid Bun throwing synchronously in start()
      queueMicrotask(() => c.error(new Error("boom")))
    },
  })
  const out = createIdleHeartbeatStream(upstream, {
    intervalMs: 1_000,
    heartbeat: enc.encode(": ping\n\n"),
  })
  const reader = out.getReader()
  await reader.read() // consume first chunk
  await expect(reader.read()).rejects.toThrow("boom")
})

test("downstream cancel cancels upstream reader", async () => {
  let cancelled: unknown = undefined
  const upstream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc.encode("data: x\n\n"))
      // intentionally do not close; keep stream alive
    },
    cancel(reason) {
      cancelled = reason
    },
  })
  const out = createIdleHeartbeatStream(upstream, {
    intervalMs: 1_000,
    heartbeat: enc.encode(": ping\n\n"),
  })
  const reader = out.getReader()
  await reader.read()
  await reader.cancel("client gone")
  // give the cancel chain a tick to propagate
  await new Promise((r) => setTimeout(r, 10))
  expect(cancelled).toBe("client gone")
})

test("does NOT inject heartbeat mid-frame (preserves SSE/JSON integrity)", async () => {
  // Simulate upstream emitting a single SSE event split across two chunks
  // with a long idle gap between them. The first chunk lacks a frame
  // terminator ("\n\n"), so injecting a heartbeat would corrupt the JSON.
  const upstream = new ReadableStream<Uint8Array>({
    async start(c) {
      // half of "data: {\"text\": \"hello world\"}\n\n"
      c.enqueue(enc.encode("data: {\"text\": \"he"))
      // long idle gap (multiple intervals); heartbeat MUST be suppressed
      await new Promise((r) => setTimeout(r, 250))
      c.enqueue(enc.encode("llo world\"}\n\n"))
      c.close()
    },
  })
  const out = createIdleHeartbeatStream(upstream, {
    intervalMs: 50,
    heartbeat: enc.encode(": ping\n\n"),
  })
  const text = await collect(out)
  // Frame must reassemble cleanly with no ping spliced inside the JSON.
  expect(text).toBe("data: {\"text\": \"hello world\"}\n\n")
  expect(text).not.toContain(": ping")
})

test("resumes heartbeats after a complete frame is delivered", async () => {
  const upstream = new ReadableStream<Uint8Array>({
    async start(c) {
      // Complete frame ends with "\n\n" → boundary, heartbeat allowed during gap.
      c.enqueue(enc.encode("data: a\n\n"))
      await new Promise((r) => setTimeout(r, 250))
      c.enqueue(enc.encode("data: b\n\n"))
      c.close()
    },
  })
  const out = createIdleHeartbeatStream(upstream, {
    intervalMs: 50,
    heartbeat: enc.encode(": ping\n\n"),
  })
  const text = await collect(out)
  expect(text).toContain(": ping")
  expect(text.indexOf(": ping")).toBeGreaterThan(text.indexOf("data: a"))
  expect(text.indexOf(": ping")).toBeLessThan(text.indexOf("data: b"))
})
