import { afterEach, beforeEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunSqliteDatabase } from "@vibe-llm/platform-bun/src/bun-sqlite-database.ts"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import { FsFileProvider } from "@vibe-llm/platform-bun/src/fs-file-provider.ts"
import type { UpstreamKind } from "@vibe-llm/protocols/common"
import { FileDumpStore } from "../src/repo/dump-store.ts"
import type { ApiKeyId, DumpRecordId, UpstreamId } from "../src/repo/branded-ids.ts"
import type { DumpWriteRecord } from "../src/shared/dump/types.ts"

const knownKinds = ["copilot", "custom", "azure", "sdf", "codex", "claude-code"] as const satisfies readonly UpstreamKind[]
const keyId = "dump-kind-key" as ApiKeyId
const recordId = "dump-kind-record" as DumpRecordId
const upstreamId = "dump-kind-upstream" as UpstreamId
let directory: string
let raw: Database
let store: FileDumpStore

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "dump-upstream-kind-"))
  raw = new Database(join(directory, "test.sqlite"))
  new BunSqliteRepo(raw)
  store = new FileDumpStore(new BunSqliteDatabase(raw), new FsFileProvider(join(directory, "files")))
  raw.run("INSERT INTO api_keys (id, name, key, created_at, dump_retention_seconds) VALUES (?, 'test', 'dump-kind-test-key', '2026-10-01', 86400)", [keyId])
})

afterEach(async () => {
  raw.close()
  await rm(directory, { recursive: true, force: true })
})

async function roundtrip(provider: string, expected: UpstreamKind): Promise<void> {
  raw.run("INSERT INTO upstreams (id, provider, name, created_at, updated_at) VALUES (?, ?, 'Upstream kind fixture', '2026-10-01', '2026-10-01')", [upstreamId, provider])
  const now = Date.now()
  const request = new TextEncoder().encode("request payload")
  const response = new TextEncoder().encode("response payload")
  const record: DumpWriteRecord = {
    meta: {
      id: recordId, startedAt: now - 1, completedAt: now, method: "POST", path: "/v1/responses", status: 200,
      // The SQL join is authoritative; deliberately use another snapshot kind.
      upstream: { id: upstreamId, name: "Capture-time name", kind: "custom" },
      model: "m", inputTokens: 1, outputTokens: 2, requestBytes: request.byteLength,
      responseBytes: response.byteLength, durationMs: 1, error: null,
    },
    request: { method: "POST", path: "/v1/responses", headers: [], body: await store.prepareRequestBody(request) },
    response: { status: 200, headers: [], body: { type: "bytes", body: response } },
  }
  await store.put(keyId, record)
  const expectedRef = { id: upstreamId, name: "Upstream kind fixture", kind: expected }
  const detail = await store.get(keyId, recordId)
  expect(detail?.meta.upstream).toEqual(expectedRef)
  expect(detail?.request.body).toEqual(request)
  expect(detail?.response.body).toEqual({ type: "bytes", body: response })
  const listed = await store.list(keyId, { limit: 10 })
  expect(listed).toHaveLength(1)
  expect(listed[0]?.upstream).toEqual(expectedRef)
}

test.each(knownKinds)("dump list and detail retain the %s upstream kind through SQLite", async kind => {
  await roundtrip(kind, kind)
})

test.each(["unknown-provider", "__proto__", "constructor", "toString", "hasOwnProperty"])(
  "dump list and detail fall back to custom for %s", async provider => {
    await roundtrip(provider, "custom")
  },
)
