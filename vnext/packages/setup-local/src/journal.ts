import { createHash } from "node:crypto"
import { closeSync, fsyncSync, openSync, writeFileSync, renameSync, lstatSync, readFileSync, unlinkSync, chmodSync } from "node:fs"
import { dirname } from "node:path"
import { fail, record } from "./contract"
import type { Client, Target } from "./contract"
import { assertSafePath, targetPath } from "./paths"
export interface JournalEntry { kind: Target; originalSha256: string | null; writtenSha256: string; mode: number; applied: boolean }
export interface Journal { version: 1; id: string; client: Client; status: "pending" | "complete" | "rolled-back" | "conflict"; entries: JournalEntry[] }
export interface SetupIO {
  write: typeof writeFileSync
  rename: typeof renameSync
  fsync: typeof fsyncSync
  unlink: typeof unlinkSync
  chmod: typeof chmodSync
  beforeRename?: (kind: Target) => void
}
export const defaultIO: SetupIO = { write: writeFileSync, rename: renameSync, fsync: fsyncSync, unlink: unlinkSync, chmod: chmodSync }
export const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
export function readPrivate(path: string, maxBytes: number): Buffer {
  assertSafePath(path)
  const stat = lstatSync(path)
  if (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())) fail("permissions", "Private setup file permissions are required")
  if (stat.size > maxBytes) fail("size", "Setup file exceeds the size limit")
  return readFileSync(path)
}
export function fileDigest(path: string): string | null {
  assertSafePath(path)
  try {
    if (lstatSync(path).size > 4_000_000) return fail("size", "Setup target exceeds the size limit")
    return digest(readFileSync(path))
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error }
}
export function syncDirectory(path: string, io: SetupIO): void {
  if (process.platform === "win32") return
  const fd = openSync(path, "r")
  try { io.fsync(fd) } finally { closeSync(fd) }
}
export function privateWrite(path: string, bytes: string | Uint8Array, io: SetupIO): void {
  assertSafePath(path)
  const fd = openSync(path, "wx", 0o600)
  try { io.write(fd, bytes); io.fsync(fd) } finally { closeSync(fd) }
  syncDirectory(dirname(path), io)
}
export function saveJournal(path: string, journal: Journal, io: SetupIO): void {
  const stage = path + ".next"
  assertSafePath(stage)
  try { io.unlink(stage) } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
  privateWrite(stage, JSON.stringify(journal) + "\n", io)
  assertSafePath(path)
  io.rename(stage, path)
  syncDirectory(dirname(path), io)
}
export function readJournal(path: string, client: Client): Journal {
  let value: Record<string, unknown>
  try { value = record(JSON.parse(readPrivate(path, 32_768).toString("utf8"))) } catch { return fail("journal", "Invalid or unreadable setup journal; preserve it for manual recovery") }
  if (value.version !== 1 || value.client !== client || typeof value.id !== "string" || !/^[0-9a-f-]{36}$/.test(value.id) || !["pending", "complete", "rolled-back", "conflict"].includes(String(value.status)) || !Array.isArray(value.entries)) fail("journal", "Invalid setup journal")
  const expected: Target[] = client === "claude" ? ["claude-settings"] : ["codex-runner", "codex-token", "codex-config"]
  if (value.entries.length !== expected.length) fail("journal", "Invalid setup journal targets")
  for (const [index, input] of value.entries.entries()) {
    const entry = record(input)
    if (entry.kind !== expected[index] || !(entry.originalSha256 === null || typeof entry.originalSha256 === "string" && /^[0-9a-f]{64}$/.test(entry.originalSha256)) || typeof entry.writtenSha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.writtenSha256) || typeof entry.mode !== "number" || !Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777 || typeof entry.applied !== "boolean") fail("journal", "Invalid setup journal entry")
  }
  return value as unknown as Journal
}
export const auxiliaryPath = (home: string, id: string, kind: Target, suffix: "backup" | "stage") => targetPath(home, kind) + ".copilot-gateway-" + id + "." + suffix
