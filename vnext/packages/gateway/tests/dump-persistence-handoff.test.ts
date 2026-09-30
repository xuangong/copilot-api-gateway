import { afterEach, beforeEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { FileProvider } from "@vibe-core/platform"
import { BunSqliteDatabase } from "@vibe-llm/platform-bun/src/bun-sqlite-database.ts"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import { FsFileProvider } from "@vibe-llm/platform-bun/src/fs-file-provider.ts"
import type { ApiKeyId, DumpRecordId } from "../src/repo/branded-ids.ts"
import { collectDumpFiles } from "../src/repo/dump-maintenance.ts"
import { FileDumpStore } from "../src/repo/dump-store.ts"
import type { DumpStreamEvent, DumpWriteRecord } from "../src/shared/dump/types.ts"
import { UpstreamExchangeCollector } from "../src/shared/dump/upstream-attempts.ts"

const keyId = "persistence-handoff-key" as ApiKeyId
const recordId = "persistence-handoff-record" as DumpRecordId
let root: string
let raw: Database
let db: BunSqliteDatabase
let realFiles: FsFileProvider

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "dump-persistence-handoff-"))
  raw = new Database(join(root, "test.sqlite"))
  new BunSqliteRepo(raw)
  db = new BunSqliteDatabase(raw)
  realFiles = new FsFileProvider(join(root, "files"))
  raw.run("INSERT INTO api_keys (id, name, key, created_at, dump_retention_seconds) VALUES (?, 'test', 'handoff-test-key', '2026-09-30', 86400)", [keyId])
})

afterEach(async () => {
  raw.close()
  await rm(root, { recursive: true, force: true })
})

type Side = "req" | "resp" | "up"
type Fault = "none" | "optional-stage" | "optional-put" | "optional-row" | "core-stage" | "core-put" | "core-row"
const sideOf = (key: string): Side => key.endsWith(".req.gz") ? "req" : key.endsWith(".resp.gz") ? "resp" : "up"
const fileRows = () => raw.query<{ file_key: string; owner_kind: string; state: string }, []>(
  "SELECT file_key, owner_kind, state FROM spilled_files ORDER BY owner_kind",
).all()

function fixture() {
  const now = Date.now()
  const collector = new UpstreamExchangeCollector(now)
  const attempt = collector.begin({ parentCallId: "handoff-call", upstreamId: "handoff-upstream", operation: "responses.create", method: "POST", startedAt: now })
  if (!attempt) throw new Error("expected upstream attempt")
  attempt.observePreparedText("upstream request")
  const envelope = collector.finish(now + 1)
  const requestBytes = Uint8Array.of(11, 12, 13)
  const requestHeaders: Array<[string, string]> = [["x-handoff", "request"]]
  const responseHeaders: Array<[string, string]> = [["x-handoff", "response"]]
  const events: DumpStreamEvent[] = [{ frame: { type: "event", event: { text: "canonical event" } }, ts: 7 }]
  const readsAfterStaging: string[] = []
  const phase = { persisting: false }
  const guard = <T extends object>(value: T, label: string): T => {
    Object.freeze(value)
    return new Proxy(value, {
      get(target, property, receiver) {
        // Real SQLite state detects the first staging side effect. Once the
        // FileProvider starts, keep the boundary even if collection removes it.
        if (phase.persisting || fileRows().length > 0) {
          const path = `${label}.${String(property)}`
          readsAfterStaging.push(path)
          throw new Error(`raw dump input read after staging: ${path}`)
        }
        return Reflect.get(target, property, receiver)
      },
    })
  }
  for (const pair of [...requestHeaders, ...responseHeaders]) Object.freeze(pair)
  Object.freeze(events[0]?.frame)
  Object.freeze(events[0])
  const input: DumpWriteRecord = guard({
    meta: guard({
      id: recordId, startedAt: now, completedAt: now + 1, method: "POST", path: "/v1/responses?handoff=1",
      status: 200, upstream: null, model: "handoff-model", inputTokens: 2, outputTokens: 3,
      requestBytes: 3, responseBytes: 19, durationMs: 1, error: null,
    }, "meta"),
    request: guard({
      method: "POST", path: "/v1/responses?handoff=1", headers: guard(requestHeaders, "request.headers"),
      body: guard({ encoding: "identity" as const, bytes: requestBytes, decodedByteLength: 3 }, "request.body"),
    }, "request"),
    response: guard({
      status: 200, headers: guard(responseHeaders, "response.headers"),
      body: guard({ type: "stream" as const, events: guard(events, "response.events") }, "response.body"),
    }, "response"),
    upstreamExchanges: envelope,
  }, "record")
  return { input, phase, readsAfterStaging, requestBytes, requestHeaders, responseHeaders, events, envelope }
}

function injectSqlFault(fault: Fault) {
  if (fault === "optional-stage") {
    raw.exec("CREATE TRIGGER handoff_reject_optional_stage BEFORE INSERT ON spilled_files WHEN NEW.owner_kind = 'dump-upstream' AND NEW.state = 'staged' BEGIN SELECT RAISE(ABORT, 'optional stage rejected'); END")
  } else if (fault === "core-stage") {
    raw.exec("CREATE TRIGGER handoff_reject_core_stage BEFORE INSERT ON spilled_files WHEN NEW.owner_kind = 'dump-request' AND NEW.state = 'staged' BEGIN SELECT RAISE(ABORT, 'core stage rejected'); END")
  } else if (fault === "optional-row") {
    raw.exec("CREATE TRIGGER handoff_reject_optional_row BEFORE INSERT ON dump_records WHEN NEW.upstream_exchanges_descriptor IS NOT NULL BEGIN SELECT RAISE(ABORT, 'optional row rejected'); END")
  } else if (fault === "core-row") {
    raw.exec("CREATE TRIGGER handoff_reject_core_row BEFORE INSERT ON dump_records BEGIN SELECT RAISE(ABORT, 'core row rejected'); END")
  }
}

test.each(["none", "optional-stage", "optional-put", "optional-row", "core-stage", "core-put", "core-row"] as const)("persistence and cleanup use no raw getters after staging (%s)", async fault => {
  injectSqlFault(fault)
  const captured = fixture()
  const uploads: Side[] = []
  const files: FileProvider = {
    async put(key, body, options) {
      captured.phase.persisting = true
      uploads.push(sideOf(key))
      await realFiles.put(key, body, options)
      // Reject after the actual write so cleanup must preserve a tombstone
      // for a partial success rather than merely discard an unused key.
      if (fault === "optional-put" && sideOf(key) === "up") throw new Error("optional put rejected")
      if (fault === "core-put" && sideOf(key) === "resp") throw new Error("core put rejected")
    },
    get: realFiles.get.bind(realFiles), delete: realFiles.delete.bind(realFiles),
  }
  const store = new FileDumpStore(db, files)
  const error: unknown = await store.put(keyId, captured.input).then(() => null, failure => failure)
  expect(captured.readsAfterStaging).toEqual([])
  expect(captured.requestBytes).toEqual(Uint8Array.of(11, 12, 13))
  expect(captured.requestHeaders).toEqual([["x-handoff", "request"]])
  expect(captured.responseHeaders).toEqual([["x-handoff", "response"]])
  expect(captured.events).toEqual([{ frame: { type: "event", event: { text: "canonical event" } }, ts: 7 }])

  if (fault === "core-stage") {
    expect(error).toBeInstanceOf(Error)
    if (!(error instanceof Error)) throw new Error("expected core stage failure")
    expect(error.message).toContain("core stage rejected")
    expect(uploads).toEqual([])
    expect(fileRows()).toEqual([])
    expect(raw.query("SELECT id FROM dump_records").all()).toEqual([])
    return
  }
  if (fault === "core-put" || fault === "core-row") {
    expect(error).toBeInstanceOf(Error)
    if (!(error instanceof Error)) throw new Error("expected core persistence failure")
    expect(error.message).toContain(fault === "core-put" ? "core put rejected" : "core row rejected")
    expect(uploads.toSorted()).toEqual(["req", "resp", "up"])
    expect(raw.query("SELECT id FROM dump_records").all()).toEqual([])
    const retired = fileRows()
    expect(retired.map(row => row.state)).toEqual(["retired", "retired", "retired"])
    for (const row of retired) expect(await realFiles.get(row.file_key)).not.toBeNull()
    expect(await collectDumpFiles(db, realFiles, Date.now() + 1)).toBe(3)
    for (const row of retired) expect(await realFiles.get(row.file_key)).toBeNull()
    expect(fileRows()).toEqual([])
    return
  }
  expect(error).toBeNull()
  expect(uploads.toSorted()).toEqual(fault === "optional-stage" ? ["req", "resp"] : ["req", "resp", "up"])
  const stored = await store.get(keyId, recordId)
  expect(stored?.meta).toMatchObject({ model: "handoff-model", requestBytes: 3, responseBytes: 19, inputTokens: 2, outputTokens: 3 })
  expect(stored?.request.headers).toEqual([["x-handoff", "request"]])
  expect(stored?.request.body).toEqual(Uint8Array.of(11, 12, 13))
  expect(stored?.response.headers).toEqual([["x-handoff", "response"]])
  expect(stored?.response.body).toEqual({ type: "stream", events: [{ frame: { type: "event", event: { text: "canonical event" } }, ts: 7 }] })
  expect(stored?.upstreamExchanges).toEqual(fault === "none" ? captured.envelope : null)
  const rows = fileRows()
  expect(rows.map(row => row.state)).toEqual(fault === "none" ? ["owned", "owned", "owned"]
    : fault === "optional-stage" ? ["owned", "owned"] : ["owned", "owned", "retired"])
  if (fault === "optional-put" || fault === "optional-row") {
    const sidecar = rows.find(row => row.owner_kind === "dump-upstream")
    if (!sidecar) throw new Error("expected optional sidecar tombstone")
    expect(await realFiles.get(sidecar.file_key)).not.toBeNull()
    expect(await collectDumpFiles(db, realFiles, Date.now() + 1)).toBe(1)
    expect(await realFiles.get(sidecar.file_key)).toBeNull()
    expect(fileRows().map(row => row.state)).toEqual(["owned", "owned"])
  }
})
