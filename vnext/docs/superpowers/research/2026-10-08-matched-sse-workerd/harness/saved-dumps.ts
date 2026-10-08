import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { readDumps, type Database, type Bucket, type LogicalDump } from "./readback"
import type { Dispatch } from "../../2026-10-07-reference-stage-measurement/harness/runtime"
import { verifyMatchedDispatch } from "./contracts"
import { fileIdentity, sha, type FileIdentity } from "../../2026-10-02-workerd-deployed-comparison/harness/manifest"
import { durableJson } from "../../2026-10-02-workerd-deployed-comparison/harness/journal"

interface Inputs { directory: string; rows: readonly Omit<LogicalDump, "variant">[]; dispatches: readonly Dispatch[]; arm: "B"; dump: boolean }
type Storage = Awaited<ReturnType<typeof readDumps>>
interface SavedObject { key: string; compressedBase64: string; bytes: number; sha256: string }
interface SavedEvidence {
  schema: "matched-sse-native-dump-evidence-v1"
  completed: boolean
  arm: "B"
  dump: boolean
  logicalSha256: string
  dispatchSha256: string
  queries: { sql: string; results: unknown[] }[]
  inventory: Awaited<ReturnType<Bucket["list"]>> | null
  objects: SavedObject[]
  error?: string
}
const evidencePath = (directory: string) => join(directory, "native-dump-evidence.json")
const logical = (options: Inputs) => options.rows.map(row => ({ ...row, variant: options.arm }))
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message) }
function population(options: Inputs) {
  check(options.arm === "B", "Matched native dump requires B")
  for (const dispatch of options.dispatches) verifyMatchedDispatch(dispatch)
  const ids = options.rows.map(row => row.id)
  check(ids.length > 0 && new Set(ids).size === ids.length && options.dispatches.length === ids.length && new Set(options.dispatches.map(row => row.id)).size === ids.length && options.dispatches.every(row => ids.includes(row.id)), "Saved dump logical/dispatch population mismatch")
  check(options.rows.every(row => options.dump ? typeof row.dumpRecordId === "string" && row.dumpRecordId.length > 0 : row.dumpRecordId === null), "Saved dump policy mismatch")
}

/** Invoked only by post-envelope physical readback; records already-read bytes. */
export async function readAndSaveNativeDumps(options: Inputs & { db: Database; bucket: Bucket }): Promise<{ storage: Storage; evidence: FileIdentity }> {
  population(options)
  const saved: SavedEvidence = { schema: "matched-sse-native-dump-evidence-v1", completed: false, arm: options.arm, dump: options.dump, logicalSha256: sha(JSON.stringify(logical(options))), dispatchSha256: sha(JSON.stringify(options.dispatches)), queries: [], inventory: null, objects: [] }
  const db: Database = { prepare: sql => ({ async all<T>() {
    const result = await options.db.prepare(sql).all<T>()
    saved.queries.push({ sql, results: structuredClone(result.results) })
    return result
  } }) }
  const bucket: Bucket = {
    async list(opts) {
      const result = await options.bucket.list(opts)
      check(typeof result.truncated === "boolean" && Array.isArray(result.objects), "Invalid physical native R2 inventory")
      const objects = result.objects.map(object => {
        const key = object.key, size = object.size
        check(typeof key === "string" && Number.isSafeInteger(size) && size >= 0, "Invalid physical native R2 object inventory")
        return { key, size }
      })
      // Runtime list entries can have methods and noncloneable proxy state.
      // Snapshot exactly the fields consumed by the oracle, then return the
      // untouched runtime result to preserve its readback behavior.
      saved.inventory = { truncated: result.truncated, objects }
      return result
    },
    async get(key) {
      const object = await options.bucket.get(key)
      if (!object) return null
      return { async arrayBuffer() {
        const bytes = await object.arrayBuffer()
        saved.objects.push({ key, compressedBase64: Buffer.from(bytes).toString("base64"), bytes: bytes.byteLength, sha256: sha(new Uint8Array(bytes)) })
        return bytes
      } }
    },
  }
  try {
    const storage = await readDumps(db, bucket, options.dump ? logical(options) : [], [...options.dispatches], { checked: new Set() }, options.arm)
    saved.completed = true
    durableJson(evidencePath(options.directory), saved, true)
    return { storage, evidence: fileIdentity(evidencePath(options.directory)) }
  } catch (error) {
    saved.error = String(error)
    durableJson(evidencePath(options.directory), saved, true)
    throw error
  }
}

/** Replays the same oracle from saved SQL, inventory and gzip bytes; no live I/O. */
export async function verifySavedNativeDumpReadback(options: Inputs & { evidence: FileIdentity; storage: unknown }): Promise<Storage> {
  population(options)
  check(resolve(options.evidence.path) === resolve(evidencePath(options.directory)), "Saved native dump evidence path identity mismatch")
  const bytes = readFileSync(options.evidence.path)
  check(bytes.byteLength === options.evidence.bytes && sha(bytes) === options.evidence.sha256, "Saved native dump evidence identity mismatch")
  const saved = JSON.parse(bytes.toString("utf8")) as SavedEvidence
  check(saved.schema === "matched-sse-native-dump-evidence-v1" && saved.completed === true && saved.arm === options.arm && saved.dump === options.dump && saved.logicalSha256 === sha(JSON.stringify(logical(options))) && saved.dispatchSha256 === sha(JSON.stringify(options.dispatches)), "Saved native dump capture identity/policy mismatch")
  check(Array.isArray(saved.queries) && saved.queries.length === 3 && saved.queries.every(query => typeof query.sql === "string" && Array.isArray(query.results)) && new Set(saved.queries.map(query => query.sql)).size === saved.queries.length, "Saved native SQL query population mismatch")
  check(saved.inventory && saved.inventory.truncated === false && Array.isArray(saved.inventory.objects) && saved.inventory.objects.every(item => typeof item.key === "string" && Number.isSafeInteger(item.size) && item.size >= 0) && new Set(saved.inventory.objects.map(item => item.key)).size === saved.inventory.objects.length, "Saved native R2 inventory population mismatch")
  check(Array.isArray(saved.objects) && saved.objects.length === saved.inventory.objects.length && new Set(saved.objects.map(object => object.key)).size === saved.objects.length, "Saved native R2 object population mismatch")
  const objects = new Map<string, Buffer>()
  for (const object of saved.objects) {
    check(typeof object.key === "string" && typeof object.compressedBase64 === "string" && Number.isSafeInteger(object.bytes) && object.bytes >= 0 && typeof object.sha256 === "string" && /^[a-f0-9]{64}$/.test(object.sha256), "Invalid saved native R2 object")
    const compressed = Buffer.from(object.compressedBase64, "base64")
    check(compressed.toString("base64") === object.compressedBase64 && compressed.byteLength === object.bytes && sha(compressed) === object.sha256 && saved.inventory.objects.some(item => item.key === object.key && item.size === object.bytes), "Saved native R2 compressed bytes/inventory mismatch")
    objects.set(object.key, compressed)
  }
  const used = new Set<string>()
  const db: Database = { prepare: sql => ({ async all<T>() {
    const query = saved.queries.find(query => query.sql === sql)
    check(query && !used.has(sql), "Missing or repeated saved native SQL query")
    used.add(sql)
    return { results: query.results as T[] }
  } }) }
  const bucket: Bucket = {
    async list() { if (!saved.inventory) throw new Error("Missing saved native inventory"); return saved.inventory },
    async get(key) { const object = objects.get(key); return object ? { async arrayBuffer() { return Uint8Array.from(object).buffer } } : null },
  }
  const storage = await readDumps(db, bucket, options.dump ? logical(options) : [], [...options.dispatches], { checked: new Set() }, options.arm)
  check(used.size === saved.queries.length, "Unused saved native SQL query")
  check(JSON.stringify(storage) === JSON.stringify(options.storage), "Saved native dump oracle differs from runtime readback receipt")
  return storage
}
