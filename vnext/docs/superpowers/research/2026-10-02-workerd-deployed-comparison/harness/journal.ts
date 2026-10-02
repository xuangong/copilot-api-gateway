import { closeSync, fsyncSync, openSync, readFileSync, writeSync, writeFileSync, renameSync } from "node:fs"
import { dirname, join } from "node:path"
import { randomUUID } from "node:crypto"

export type Event = Record<string, unknown> & { event: string }
export interface CompletionFlags {
  dispatchExactlyOnce: boolean
  storageReadback: boolean
  backgroundSettled: boolean
  cleanupComplete: boolean
  identitiesMatch: boolean
}
export class Journal {
  private readonly fd: number
  constructor(readonly path: string) { this.fd = openSync(path, "wx", 0o600) }
  append(row: Event) {
    const bytes = Buffer.from(JSON.stringify({ ...row, at: new Date().toISOString() }) + "\n")
    let offset = 0
    while (offset < bytes.length) offset += writeSync(this.fd, bytes, offset)
    fsyncSync(this.fd)
  }
  close() { fsyncSync(this.fd); closeSync(this.fd) }
}
export function readJournal(path: string): Event[] {
  const text = readFileSync(path, "utf8")
  if (text && !text.endsWith("\n")) throw new Error("Truncated original journal cannot qualify")
  return text.split("\n").filter(Boolean).map(line => {
    const value: unknown = JSON.parse(line)
    if (!value || typeof value !== "object" || !("event" in value) || typeof value.event !== "string") throw new Error("Invalid journal event")
    return value as Event
  })
}
export function collectionEvidence(rows: Event[], expected: number, flags: CompletionFlags) {
  const offered = rows.filter(row => row.event === "offered")
  const terminal = rows.filter(row => row.event === "terminal")
  const offeredIds = new Set(offered.map(row => row.id))
  const terminalIds = new Set(terminal.map(row => row.id))
  const validIds = [...offeredIds, ...terminalIds].every(id => typeof id === "string" && id.length > 0)
  const exact = validIds && offered.length === expected && terminal.length === expected
    && offeredIds.size === expected && terminalIds.size === expected
    && [...offeredIds].every(id => terminalIds.has(id))
  const eofComplete = terminal.every(row => row.transportCompleted === true)
  const nonMatrixOracle = terminal.every(row => row.phase === "matrix" || row.ok === true)
  return { expected, offered: offered.length, terminal: terminal.length, uniqueOffered: offeredIds.size, uniqueTerminal: terminalIds.size, exact, eofComplete, nonMatrixOracle, ...flags,
    completed: exact && eofComplete && nonMatrixOracle && Object.values(flags).every(Boolean) }
}
/** Atomic dispositions may advance; the original journal is append-only. */
export function durableJson(path: string, value: unknown, initial = false) {
  if (initial) {
    const fd = openSync(path, "wx", 0o600)
    try { writeFileSync(fd, JSON.stringify(value, null, 2) + "\n"); fsyncSync(fd) } finally { closeSync(fd) }
  } else {
    const pending = join(dirname(path), `.receipt-${randomUUID()}.tmp`)
    durableJson(pending, value, true)
    renameSync(pending, path)
  }
  const fd = openSync(dirname(path), "r")
  try { fsyncSync(fd) } finally { closeSync(fd) }
}
