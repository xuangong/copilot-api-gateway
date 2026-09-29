import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { Database } from "bun:sqlite"
import { BunSqliteDatabase } from "@vibe-llm/platform-bun/src/bun-sqlite-database.ts"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import { eventFrame } from "@vibe-core/result"
import type { FileProvider } from "@vibe-core/platform"
import { FileDumpStore } from "../src/repo/dump-store.ts"
import { UpstreamExchangeCollector, safeUpstreamExchangesForPersistence } from "../src/shared/dump/upstream-attempts.ts"
import type { DumpStreamEvent, DumpWriteRecord } from "../src/shared/dump/types.ts"
import type { ApiKeyId, DumpRecordId } from "../src/repo/branded-ids.ts"

type Branch = "stream" | "bun"
type Side = "req" | "resp" | "up"
const keyId = "json-compression-key" as ApiKeyId
const encoder = new TextEncoder()
let raw: Database
let store: FileDumpStore
let files: Map<string, Uint8Array>

beforeEach(() => {
  raw = new Database(":memory:")
  new BunSqliteRepo(raw)
  files = new Map()
  const provider: FileProvider = {
    async put(key, body) {
      if (!(body instanceof Uint8Array)) throw new Error("expected prepared bytes")
      files.set(key, body)
    },
    async get() { return null },
    async delete(key) { files.delete(key) },
  }
  store = new FileDumpStore(new BunSqliteDatabase(raw), provider)
  raw.run("INSERT INTO api_keys (id, name, key, created_at, dump_retention_seconds) VALUES (?, 'test', 'test-key', '2026-09-30', 3600)", [keyId])
})
afterEach(() => { raw.close() })

function record(events: DumpStreamEvent[] = []): DumpWriteRecord {
  const now = Date.now()
  return {
    meta: {
      id: crypto.randomUUID() as DumpRecordId, startedAt: now - 1, completedAt: now,
      method: "POST", path: "/v1/responses", status: 200, upstream: null,
      model: null, inputTokens: null, outputTokens: null,
      requestBytes: 0, responseBytes: 1, durationMs: 1, error: null,
    },
    request: { method: "POST", path: "/v1/responses", headers: [], body: { encoding: "identity", bytes: new Uint8Array(), decodedByteLength: 0 } },
    response: { status: 200, headers: [], body: { type: "stream", events } },
  }
}

function snapshot() {
  const collector = new UpstreamExchangeCollector()
  const attempt = collector.begin({ parentCallId: "call-1", upstreamId: "upstream-1", method: "POST", operation: "responses.create" })
  if (!attempt) throw new Error("expected first attempt capture")
  attempt.observePreparedText("request 中文 😀".repeat(128))
  return collector.finish()
}

function uploaded(input: DumpWriteRecord, side: Side): Uint8Array {
  const value = [...files].find(([key]) => key.includes(`/${input.meta.id}-`) && key.endsWith(`.${side}.gz`))?.[1]
  if (!value) throw new Error(`missing ${side} upload`)
  return value
}

// This transparent stream isolates the real store's Blob/input decisions.
// Actual gzip behavior is checked with Bun below and separately in workerd.
async function withBranch<T>(branch: Branch, run: (parts: BlobPart[][]) => Promise<T>): Promise<T> {
  const compressionDescriptor = Object.getOwnPropertyDescriptor(globalThis, "CompressionStream")
  const blobDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Blob")
  if (!blobDescriptor) throw new Error("Blob is unavailable")
  const OriginalBlob = globalThis.Blob
  const parts: BlobPart[][] = []
  class ObservedBlob extends OriginalBlob {
    constructor(input: BlobPart[] = [], options?: BlobPropertyBag) {
      parts.push(input)
      super(input, options)
    }
  }
  class TransparentCompressionStream extends TransformStream<Uint8Array, Uint8Array> {
    constructor(format: CompressionFormat) {
      if (format !== "gzip") throw new Error("unexpected compression format")
      super()
    }
  }
  Object.defineProperty(globalThis, "CompressionStream", { configurable: true, writable: true, value: branch === "stream" ? TransparentCompressionStream : undefined })
  if (branch === "stream") Object.defineProperty(globalThis, "Blob", { ...blobDescriptor, value: ObservedBlob })
  try { return await run(parts) }
  finally {
    Object.defineProperty(globalThis, "Blob", blobDescriptor)
    if (compressionDescriptor) Object.defineProperty(globalThis, "CompressionStream", compressionDescriptor)
    else Reflect.deleteProperty(globalThis, "CompressionStream")
  }
}

const decoded = (branch: Branch, bytes: Uint8Array): Uint8Array => branch === "bun" ? Bun.gunzipSync(bytes) : bytes

test("JSON sidecar and event compression enter Blob without explicit UTF-8 arrays", async () => {
  const events = [{ ts: 0, frame: eventFrame({ text: "control\u0000\n\"\\ 中文😀\ud800".repeat(128) }) }]
  const input = record(events)
  input.upstreamExchanges = snapshot()
  const expected = [JSON.stringify(safeUpstreamExchangesForPersistence(input.upstreamExchanges)), JSON.stringify(events)]
  let encodedInputBytes = 0
  const encode = TextEncoder.prototype.encode
  const observer = spyOn(TextEncoder.prototype, "encode").mockImplementation(function (this: TextEncoder, value) {
    const bytes = encode.call(this, value)
    if (expected.includes(value ?? "")) encodedInputBytes += bytes.byteLength
    return bytes
  })
  try {
    await withBranch("stream", async parts => {
      await store.put(keyId, input)
      expect(encodedInputBytes).toBe(0)
      expect(parts).toEqual(expected.map(value => [value]))
      expect(new TextDecoder().decode(uploaded(input, "up"))).toBe(expected[0])
      expect(new TextDecoder().decode(uploaded(input, "resp"))).toBe(expected[1])
    })
  } finally { observer.mockRestore() }
})

test.each(["stream", "bun"] as const)("%s branch preserves JSON UTF-8 and one-time serialization", async branch => {
  const payload = ["", "ASCII", "\u0000\b\t\n\r\"/\\", "中文😀", "\ud800", "\udc00", "\ud800\udc00"]
  const expected = encoder.encode(JSON.stringify(payload))
  let calls = 0
  const events = Object.assign([] as DumpStreamEvent[], { toJSON() { calls++; return payload } })
  const input = record(events)
  await withBranch(branch, async () => {
    await store.put(keyId, input)
    expect(decoded(branch, uploaded(input, "resp"))).toEqual(expected)
  })
  expect(calls).toBe(1)
})

test.each(["stream", "bun"] as const)("%s branch preserves undefined, null and empty-array serialization", async branch => {
  await withBranch(branch, async () => {
    for (const value of [undefined, null, []]) {
      let calls = 0
      const events = Object.assign([] as DumpStreamEvent[], { toJSON() { calls++; return value } })
      const input = record(events)
      await store.put(keyId, input)
      expect(decoded(branch, uploaded(input, "resp"))).toEqual(encoder.encode(JSON.stringify(value)))
      expect(calls).toBe(1)
      expect(raw.query<{ response_body_descriptor: string }, [string]>("SELECT response_body_descriptor FROM dump_records WHERE id = ?").get(input.meta.id)?.response_body_descriptor).toContain('"type":"events"')
    }
  })
})

test.each(["stream", "bun"] as const)("%s branch preserves prepared-byte ownership and skips recompression", async branch => {
  await withBranch(branch, async parts => {
    const original = Uint8Array.of(0, 255, 254, 128, 65)
    const requestBytes = original.slice()
    const preparing = store.prepareRequestBody(requestBytes)
    requestBytes.fill(42)
    const prepared = await preparing
    expect(decoded(branch, prepared.bytes)).toEqual(original)
    expect(prepared.decodedByteLength).toBe(original.byteLength)
    const responseBytes = Uint8Array.of(255, 0, 192, 128)
    const input = record()
    input.request.body = prepared
    input.response.body = { type: "bytes", body: responseBytes }
    await store.put(keyId, input)
    expect(uploaded(input, "req")).toBe(prepared.bytes)
    expect(decoded(branch, uploaded(input, "resp"))).toEqual(responseBytes)
    if (branch === "stream") {
      expect(parts).toHaveLength(2)
      expect(parts[0]?.[0]).toBe(requestBytes)
      expect(parts[1]?.[0]).toBe(responseBytes)
    }
  })
})

test("Bun fallback still receives encoded byte arrays for JSON strings and undefined", async () => {
  await withBranch("bun", async () => {
    for (const value of [{ text: "中文😀\ud800" }, undefined]) {
      const expected = encoder.encode(JSON.stringify(value))
      const input = record(Object.assign([] as DumpStreamEvent[], { toJSON: () => value }))
      const inputs: unknown[] = []
      const gzipSync = Bun.gzipSync
      const observer = spyOn(Bun, "gzipSync").mockImplementation((...args) => { inputs.push(args[0]); return gzipSync(...args) })
      try { await store.put(keyId, input) }
      finally { observer.mockRestore() }
      expect(inputs).toHaveLength(1)
      expect(inputs[0]).toBeInstanceOf(Uint8Array)
      expect(inputs[0]).toEqual(expected)
      expect(Bun.gunzipSync(uploaded(input, "resp"))).toEqual(expected)
    }
  })
})

test.each(["stream", "bun"] as const)("%s branch preserves serialization errors before uploads and retires staged files", async branch => {
  await withBranch(branch, async () => {
    const thrown = new Error("toJSON failed")
    const circular: unknown[] = []
    circular.push(circular)
    for (const events of [
      Object.assign([] as DumpStreamEvent[], { toJSON() { throw thrown } }),
      circular as DumpStreamEvent[],
      [1n] as unknown as DumpStreamEvent[],
    ]) {
      const input = record(events)
      input.upstreamExchanges = snapshot()
      const before = files.size
      await expect(store.put(keyId, input)).rejects.toThrow()
      expect(files.size).toBe(before)
      expect(raw.query("SELECT id FROM dump_records WHERE id = ?").get(input.meta.id)).toBeNull()
      const states = raw.query<{ state: string }, [string]>("SELECT state FROM spilled_files WHERE json_extract(owner_key, '$[1]') = ?").all(input.meta.id)
      expect(states.map(item => item.state)).toEqual(["retired", "retired"])
    }
  })
})

test.each(["stream", "bun"] as const)("%s branch keeps malformed optional sidecar independent of canonical events", async branch => {
  await withBranch(branch, async () => {
    const input = record([{ ts: 0, frame: eventFrame({ ok: true }) }])
    input.upstreamExchanges = { ...snapshot(), capturedBodyBytes: -1 }
    await store.put(keyId, input)
    const row = raw.query<{ upstream_exchanges_descriptor: string | null }, [string]>("SELECT upstream_exchanges_descriptor FROM dump_records WHERE id = ?").get(input.meta.id)
    expect(row?.upstream_exchanges_descriptor).toBeNull()
    expect([...files.keys()].filter(key => key.includes(`/${input.meta.id}-`))).toHaveLength(1)
    const response = decoded(branch, uploaded(input, "resp"))
    expect(JSON.parse(new TextDecoder().decode(response))).toEqual(input.response.body.type === "stream" ? input.response.body.events : null)
  })
})
