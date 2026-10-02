import { test, expect } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Journal, readJournal, collectionEvidence } from "./journal.ts"
import { deadline, supervise } from "./supervisor.ts"
import { selectTarget } from "./inspector.ts"
import { fileIdentity, verifyFiles, verifyManifest, type Manifest } from "./manifest.ts"

const temp = () => mkdtempSync(join(tmpdir(), "bounded-workerd-test-"))
const terminal = (id: string) => ({ event: "terminal" as const, id, phase: "latency", transportCompleted: true, ok: true })
test("rejects missing terminal, duplicate IDs and identity failure despite successful exit", () => {
  const flags = { dispatchExactlyOnce: true, storageReadback: true, backgroundSettled: true, cleanupComplete: true, identitiesMatch: true }
  const rows = [{ event: "offered", id: "one" }, terminal("one")]
  expect(collectionEvidence(rows, 1, flags).completed).toBe(true)
  expect(collectionEvidence(rows, 2, flags).completed).toBe(false)
  expect(collectionEvidence([...rows, terminal("one")], 1, flags).completed).toBe(false)
  expect(collectionEvidence([...rows, { event: "offered", id: "one" }], 1, flags).completed).toBe(false)
  expect(collectionEvidence([{ event: "offered", id: "one" }], 1, flags).completed).toBe(false)
  expect(collectionEvidence(rows, 1, { ...flags, identitiesMatch: false }).completed).toBe(false)
  expect(collectionEvidence([{ event: "offered", id: "one" }, { ...terminal("one"), transportCompleted: false }], 1, flags).completed).toBe(false)
})
test("retains durable offered/error rows and rejects a truncated original journal", () => {
  const path = join(temp(), "journal.jsonl")
  const journal = new Journal(path)
  journal.append({ event: "offered", id: "failed" })
  journal.append({ ...terminal("failed"), ok: false, transportCompleted: false, errors: ["timeout"] })
  journal.close()
  expect(readJournal(path)).toHaveLength(2)
  const original = readFileSync(path, "utf8")
  writeFileSync(path, original + '{"event":"terminal"')
  expect(() => readJournal(path)).toThrow("Truncated")
  expect(readFileSync(path, "utf8")).toBe(original + '{"event":"terminal"')
  expect(() => new Journal(path)).toThrow()
})
test("detects actual manifest input drift", () => {
  const path = join(temp(), "input")
  writeFileSync(path, "frozen")
  const identity = fileIdentity(path)
  verifyFiles([identity])
  writeFileSync(path, "drifted")
  expect(() => verifyFiles([identity])).toThrow("drift")
})
function executionManifest(): Manifest {
  const root = temp()
  for (const name of ["apps", "packages", "scripts"]) mkdirSync(join(root, "vnext", name), { recursive: true })
  const bun = fileIdentity(realpathSync(process.execPath))
  const input = { root, head: "fixture", files: [], bundle: "unused", migrationRoot: "unused" }
  return { version: 1, id: "fixture", createdAt: "fixture", count: 40, warmup: 12, expected: 716,
    execution: bun, variants: { A: { ...input, representation: "deployed-legacy" }, B: { ...input, representation: "current-v1" } },
    resolution: [], tools: [], dependencies: [bun], artifacts: [], build: [],
    runtime: { bun: "1.3.0", miniflare: "4.20260601.0", workerd: "1.20260601.1", wrangler: "4.97.0", compatibilityDate: "2025-06-01", compatibilityFlags: ["nodejs_compat"] } } as Manifest
}
test("runtime identity rejects ambient workerd/debug overrides without launching runtime", () => {
  const manifest = executionManifest()
  verifyManifest(manifest)
  for (const key of ["MINIFLARE_WORKERD_PATH", "VSCODE_INSPECTOR_OPTIONS", "NODE_OPTIONS"]) {
    const original = process.env[key]
    try {
      for (const value of ["disposable-override", ""]) {
        process.env[key] = value
        expect(() => verifyManifest(manifest)).toThrow(`Unsafe runtime environment: ${key}`)
      }
    } finally { if (original === undefined) delete process.env[key]; else process.env[key] = original }
  }
})
test("runtime identity rejects a different actual Bun identity while frozen bytes still exist", () => {
  const manifest = executionManifest()
  const alternative = join(temp(), "alternative-bun")
  writeFileSync(alternative, "disposable executable identity")
  const changed = { ...manifest, execution: fileIdentity(alternative) }
  expect(() => verifyManifest(changed)).toThrow("Current Bun executable drift")
  verifyFiles(manifest.dependencies)
})
test("stage timeout names the independently bounded stage", async () => {
  await expect(deadline("binding", 20, () => new Promise<void>(() => {}))).rejects.toThrow("binding timed out")
})
test("inspector never selects unrelated or ambiguous targets", () => {
  expect(selectTarget([{ title: "Cloudflare Worker", webSocketDebuggerUrl: "ws://127.0.0.1:1/gateway-exact" }], "gateway-exact").title).toBe("Cloudflare Worker")
  expect(() => selectTarget([{ title: "other", webSocketDebuggerUrl: "ws://127.0.0.1:1" }], "gateway-exact")).toThrow("exact")
  expect(selectTarget([{ title: "gateway-exact", webSocketDebuggerUrl: "ws://127.0.0.1:1/gateway-exact" }], "gateway-exact").title).toBe("gateway-exact")
  expect(() => selectTarget([{ title: "gateway-exact", webSocketDebuggerUrl: "ws://127.0.0.1:1/gateway-exact" }, { title: "gateway-exact", webSocketDebuggerUrl: "ws://127.0.0.1:2/gateway-exact" }], "gateway-exact")).toThrow("exact")
})
test("whole-child deadline physically kills an owned loopback child while leaving unrelated child alive", async () => {
  const directory = temp()
  const ownedPath = join(directory, "owned.pid")
  const other = Bun.spawn([process.execPath, "-e", "setInterval(()=>{},1000)"], { stdout: "ignore", stderr: "ignore" })
  try {
    const result = await supervise({ command: process.execPath, args: ["-e", `require('fs').writeFileSync(${JSON.stringify(ownedPath)},String(process.pid)); require('http').createServer((q,s)=>s.end('ok')).listen(0,'127.0.0.1'); process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)`], directory, timeoutMs: 400, graceMs: 100 })
    expect(result.timedOut).toBe(true)
    expect(result.cleanupComplete).toBe(true)
    const pid = Number(readFileSync(ownedPath, "utf8"))
    expect(() => process.kill(pid, 0)).toThrow()
    expect(() => process.kill(other.pid, 0)).not.toThrow()
  } finally { other.kill(); await other.exited }
}, 5000)

test("cleanup owns surviving grandchild group after parent exit and preserves unrelated loopback listener", async () => {
  const directory = temp()
  const grandchildPath = join(directory, "grandchild.pid")
  const other = Bun.spawn([process.execPath, "-e", "require('http').createServer((q,s)=>s.end('safe')).listen(0,'127.0.0.1')"], { stdout: "ignore", stderr: "ignore" })
  const grandchild = `require('http').createServer((q,s)=>s.end('owned')).listen(0,'127.0.0.1',()=>require('fs').writeFileSync(${JSON.stringify(grandchildPath)},String(process.pid))); process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)`
  const parent = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore'}); const timer=setInterval(()=>{if(require('fs').existsSync(${JSON.stringify(grandchildPath)})){clearInterval(timer);process.exit(0)}},5)`
  try {
    const result = await supervise({ command: process.execPath, args: ["-e", parent], directory, timeoutMs: 2000, graceMs: 300 })
    expect(result.exitCode).toBe(0)
    expect(result.cleanupComplete).toBe(true)
    expect(result.actions).toContain("SIGKILL")
    expect(() => process.kill(Number(readFileSync(grandchildPath, "utf8")), 0)).toThrow()
    expect(() => process.kill(other.pid, 0)).not.toThrow()
  } finally { other.kill(); await other.exited }
}, 5000)
