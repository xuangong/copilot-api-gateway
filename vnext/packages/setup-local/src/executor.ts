import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { randomUUID } from "node:crypto"
import { fail, SetupError } from "./contract"
import type { Client, Target } from "./contract"
import type { CurrentFile, SetupPlan } from "./planner"
import { assertSafePath, stateDirectory, targetPath } from "./paths"
import { auxiliaryPath, defaultIO, digest, fileDigest, privateWrite, readJournal, readPrivate, saveJournal, syncDirectory } from "./journal"
import type { Journal, SetupIO } from "./journal"

function ensureDirectory(path: string): void {
  assertSafePath(path, false)
  mkdirSync(path, { recursive: true, mode: 0o700 })
  assertSafePath(path, false)
}
function statePaths(home: string, client: Client) {
  const directory = stateDirectory(home, client)
  return { directory, journal: join(directory, "setup-journal.json"), lock: join(directory, "setup.lock") }
}
function takeLock(home: string, client: Client, recovery: boolean): () => void {
  const paths = statePaths(home, client)
  ensureDirectory(paths.directory)
  const stat = lstatSync(paths.directory)
  if (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())) fail("permissions", "Setup recovery directory must be private")
  assertSafePath(paths.lock)
  if (recovery && existsSync(paths.lock)) {
    const pid = Number(readPrivate(paths.lock, 32).toString("utf8").trim())
    if (!Number.isSafeInteger(pid) || pid < 1) fail("lock", "Invalid setup lock; inspect it manually")
    try { process.kill(pid, 0); return fail("lock", "Another setup process is active") } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
    }
    unlinkSync(paths.lock)
  }
  let fd: number
  try { fd = openSync(paths.lock, "wx", 0o600) } catch { return fail("lock", "Setup is locked; inspect or recover the previous transaction") }
  try { writeFileSync(fd, String(process.pid) + "\n") } finally { closeSync(fd) }
  return () => { assertSafePath(paths.lock); unlinkSync(paths.lock) }
}
export function readCurrentFiles(home: string, client: Client): CurrentFile[] {
  const kinds: Target[] = client === "claude" ? ["claude-settings"] : ["codex-runner", "codex-token", "codex-config"]
  return kinds.map(kind => {
    const path = targetPath(home, kind)
    const expectedSha256 = fileDigest(path)
    return { kind, expectedSha256, bytes: expectedSha256 === null ? null : readFileSync(path) }
  })
}
function rollback(home: string, path: string, journal: Journal, io: SetupIO): boolean {
  let conflict = false
  for (const entry of [...journal.entries].reverse()) {
    try {
      const target = targetPath(home, entry.kind)
      const current = fileDigest(target)
      if (current === entry.originalSha256) continue
      if (!entry.applied) { conflict = true; continue }
      if (current !== entry.writtenSha256) { conflict = true; continue }
      if (entry.originalSha256 === null) io.unlink(target)
      else {
        const backup = auxiliaryPath(home, journal.id, entry.kind, "backup")
        const bytes = readPrivate(backup, 4_000_000)
        if (digest(bytes) !== entry.originalSha256) { conflict = true; continue }
        const stage = auxiliaryPath(home, journal.id, entry.kind, "stage")
        if (existsSync(stage)) { assertSafePath(stage); io.unlink(stage) }
        privateWrite(stage, bytes, io)
        io.chmod(stage, entry.mode)
        if (fileDigest(target) !== entry.writtenSha256) { conflict = true; continue }
        io.rename(stage, target)
      }
      syncDirectory(dirname(target), io)
    } catch { conflict = true }
  }
  journal.status = conflict ? "conflict" : "rolled-back"
  saveJournal(path, journal, io)
  return !conflict
}
export async function executeSetup(input: { allowedHome: string; plan: SetupPlan; dryRun?: boolean; io?: Partial<SetupIO> }): Promise<{ status: "dry-run" | "complete"; journalPath?: string; redactedDiff: string }> {
  const { allowedHome, plan } = input
  const io = { ...defaultIO, ...input.io }
  if (allowedHome !== plan.allowedHome) fail("path", "Plan home does not match the allowed home")
  const kinds = plan.client === "claude" ? ["claude-settings"] : ["codex-runner", "codex-token", "codex-config"]
  if (plan.files.length !== kinds.length || plan.files.some((file, index) => file.kind !== kinds[index] || digest(file.bytes) !== file.writtenSha256)) fail("plan", "Invalid setup plan")
  for (const file of plan.files) {
    if (fileDigest(targetPath(allowedHome, file.kind)) !== file.expectedSha256) fail("conflict", "Configuration changed; generate a new local plan")
  }
  if (input.dryRun) return { status: "dry-run", redactedDiff: plan.redactedDiff }
  const paths = statePaths(allowedHome, plan.client)
  const release = takeLock(allowedHome, plan.client, false)
  let journal: Journal | undefined
  try {
    assertSafePath(paths.journal)
    if (existsSync(paths.journal)) fail("journal", "A retained journal exists; run recover or cleanup before a new setup")
    journal = { version: 1, id: randomUUID(), client: plan.client, status: "pending", entries: plan.files.map(file => {
      const path = targetPath(allowedHome, file.kind)
      return { kind: file.kind, originalSha256: file.expectedSha256, writtenSha256: file.writtenSha256, applied: false,
        mode: file.expectedSha256 === null ? 0o600 : lstatSync(path).mode & 0o777 }
    }) }
    saveJournal(paths.journal, journal, io)
    for (const file of plan.files) {
      const target = targetPath(allowedHome, file.kind)
      ensureDirectory(dirname(target))
      if (fileDigest(target) !== file.expectedSha256) fail("conflict", "Configuration changed before staging")
      if (file.expectedSha256 !== null) {
        const original = readFileSync(target)
        if (digest(original) !== file.expectedSha256) fail("conflict", "Configuration changed while reading the backup")
        privateWrite(auxiliaryPath(allowedHome, journal.id, file.kind, "backup"), original, io)
      }
      privateWrite(auxiliaryPath(allowedHome, journal.id, file.kind, "stage"), file.bytes, io)
    }
    for (const [index, file] of plan.files.entries()) {
      const target = targetPath(allowedHome, file.kind)
      io.beforeRename?.(file.kind)
      if (fileDigest(target) !== file.expectedSha256) fail("conflict", "Configuration changed immediately before replacement")
      const entry = journal.entries[index]
      if (!entry) fail("journal", "Missing transaction entry")
      entry.applied = true
      saveJournal(paths.journal, journal, io)
      // Journal writes may themselves yield to an external editor.
      if (fileDigest(target) !== file.expectedSha256) fail("conflict", "Configuration changed immediately before replacement")
      io.rename(auxiliaryPath(allowedHome, journal.id, file.kind, "stage"), target)
      syncDirectory(dirname(target), io)
    }
    journal.status = "complete"
    saveJournal(paths.journal, journal, io)
    return { status: "complete", journalPath: paths.journal, redactedDiff: plan.redactedDiff }
  } catch (error) {
    if (journal) {
      // Test interruption models a killed process; explicit recovery uses the
      // durable intents rather than assuming the last rename did not happen.
      if (error instanceof SetupError && error.code === "interrupted") throw error
      let recovery: "rolled-back" | "conflict" | "unknown" = "unknown"
      try { recovery = rollback(allowedHome, paths.journal, journal, io) ? "rolled-back" : "conflict" } catch { /* Keep all artifacts for explicit recovery. */ }
      const action = recovery === "rolled-back" ? "cleanup" : "recover"
      const prefix = error instanceof SetupError && error.code === "conflict" ? "Configuration changed; setup stopped." : "Setup failed."
      return fail(error instanceof SetupError ? error.code : "transaction", prefix + " Recovery state: " + recovery + ". Retained journal: " + paths.journal + ". Run " + action + " " + plan.client + " after inspection before another setup; retain backups until recovery is resolved")
    }
    if (error instanceof SetupError) throw error
    return fail("transaction", "Setup failed; retain backups and journal, then run recover. A new lease is required for another setup")
  } finally { release() }
}
export function recoverSetup(home: string, client: Client, action: "recover" | "cleanup", supplied?: Partial<SetupIO>): string {
  const io = { ...defaultIO, ...supplied }
  const paths = statePaths(home, client)
  const release = takeLock(home, client, true)
  try {
    const journal = readJournal(paths.journal, client)
    if (action === "recover") {
      if (journal.status === "complete") fail("journal", "Setup completed; use cleanup to remove retained backups")
      if (!rollback(home, paths.journal, journal, io)) fail("conflict", "Recovery preserved concurrent edits; backups and journal remain for manual recovery")
      return "Rollback complete; backups and journal retained until explicit cleanup"
    }
    if (!["complete", "rolled-back"].includes(journal.status)) fail("journal", "Unresolved journal; recover before cleanup")
    for (const entry of journal.entries) for (const suffix of ["backup", "stage"] as const) {
      const path = auxiliaryPath(home, journal.id, entry.kind, suffix)
      assertSafePath(path)
      if (existsSync(path)) io.unlink(path)
    }
    assertSafePath(paths.journal + ".next")
    if (existsSync(paths.journal + ".next")) io.unlink(paths.journal + ".next")
    io.unlink(paths.journal)
    syncDirectory(paths.directory, io)
    return "Retained setup backups and journal removed"
  } finally { release() }
}
