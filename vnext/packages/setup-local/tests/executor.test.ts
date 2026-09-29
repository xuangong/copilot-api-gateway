import { expect, test } from "bun:test"
import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { executeSetup, recoverSetup } from "../src/executor"
import { defaultIO } from "../src/journal"
import { SetupError } from "../src/contract"
import { targetPath, stateDirectory } from "../src/paths"
import { plan, temporaryHome, credential } from "./fixtures"

test("dry run writes nothing; completed setup preserves private backups until cleanup", async () => {
  const fixture = temporaryHome()
  try {
    const prepared = await plan(fixture.home)
    expect((await executeSetup({ allowedHome: fixture.home, plan: prepared, dryRun: true })).status).toBe("dry-run")
    expect(existsSync(join(fixture.home, ".codex"))).toBe(false)
    await executeSetup({ allowedHome: fixture.home, plan: prepared })
    for (const file of prepared.files) expect(lstatSync(targetPath(fixture.home, file.kind)).mode & 0o777).toBe(0o600)
    expect(readFileSync(targetPath(fixture.home, "codex-token"), "utf8").trim()).toBe(credential)
    await expect(executeSetup({ allowedHome: fixture.home, plan: await plan(fixture.home) })).rejects.toThrow("journal")
    expect(recoverSetup(fixture.home, "codex", "cleanup")).toContain("removed")
    expect(existsSync(join(stateDirectory(fixture.home, "codex"), "setup-journal.json"))).toBe(false)
  } finally { fixture.cleanup() }
})
for (const kind of ["codex-runner", "codex-token", "codex-config"] as const) test("preserves concurrent edits before rename of " + kind, async () => {
  const fixture = temporaryHome()
  try {
    const prepared = await plan(fixture.home)
    await expect(executeSetup({ allowedHome: fixture.home, plan: prepared, io: { beforeRename: current => { if (current === kind) writeFileSync(targetPath(fixture.home, kind), "concurrent\n") } } })).rejects.toThrow("changed")
    expect(readFileSync(targetPath(fixture.home, kind), "utf8")).toBe("concurrent\n")
    expect(readFileSync(join(stateDirectory(fixture.home, "codex"), "setup-journal.json"), "utf8")).toContain('"conflict"')
  } finally { fixture.cleanup() }
})
for (const operation of ["write", "fsync", "rename"] as const) test("retains recovery artifacts after injected " + operation + " failure", async () => {
  const fixture = temporaryHome()
  try {
    const prepared = await plan(fixture.home)
    let calls = 0
    const io = { [operation]: (...args: unknown[]) => {
      if (++calls === 4) throw Object.assign(new Error("fixture I/O failure"), { code: operation === "write" ? "ENOSPC" : "EACCES" })
      return Reflect.apply(defaultIO[operation], undefined, args)
    } }
    await expect(executeSetup({ allowedHome: fixture.home, plan: prepared, io })).rejects.toThrow()
    expect(existsSync(targetPath(fixture.home, "codex-token"))).toBe(false)
  } finally { fixture.cleanup() }
})
test("interrupted journal rolls back only transaction bytes and preserves original config/mode", async () => {
  const fixture = temporaryHome()
  try {
    mkdirSync(join(fixture.home, ".codex"))
    writeFileSync(targetPath(fixture.home, "codex-config"), '# keep\nmodel = "before"\n', { mode: 0o640 })
    const prepared = await plan(fixture.home)
    await expect(executeSetup({ allowedHome: fixture.home, plan: prepared, io: { beforeRename: kind => { if (kind === "codex-token") throw new SetupError("interrupted", "fixture interruption") } } })).rejects.toThrow("interruption")
    expect(existsSync(targetPath(fixture.home, "codex-runner"))).toBe(true)
    expect(recoverSetup(fixture.home, "codex", "recover")).toContain("Rollback complete")
    expect(existsSync(targetPath(fixture.home, "codex-runner"))).toBe(false)
    expect(readFileSync(targetPath(fixture.home, "codex-config"), "utf8")).toBe('# keep\nmodel = "before"\n')
    expect(lstatSync(targetPath(fixture.home, "codex-config")).mode & 0o777).toBe(0o640)
  } finally { fixture.cleanup() }
})
test("recovery refuses to overwrite edits made after interruption", async () => {
  const fixture = temporaryHome()
  try {
    await expect(executeSetup({ allowedHome: fixture.home, plan: await plan(fixture.home), io: { beforeRename: kind => { if (kind === "codex-token") throw new SetupError("interrupted", "fixture interruption") } } })).rejects.toThrow()
    writeFileSync(targetPath(fixture.home, "codex-runner"), "external edit")
    expect(() => recoverSetup(fixture.home, "codex", "recover")).toThrow("concurrent")
    expect(readFileSync(targetPath(fixture.home, "codex-runner"), "utf8")).toBe("external edit")
    expect(() => recoverSetup(fixture.home, "codex", "cleanup")).toThrow("Unresolved")
  } finally { fixture.cleanup() }
})
for (const outcome of ["conflict", "rolled-back", "unknown"] as const) test(`failure diagnostic reports ${outcome} recovery state and journal without secrets`, async () => {
  const fixture = temporaryHome()
  try {
    const prepared = await plan(fixture.home)
    const journal = join(stateDirectory(fixture.home, "codex"), "setup-journal.json")
    let failed = false
    const error = await executeSetup({ allowedHome: fixture.home, plan: prepared, io: {
      beforeRename: kind => {
        if (kind !== "codex-token") return
        if (outcome === "conflict") writeFileSync(targetPath(fixture.home, kind), credential)
        else { failed = true; throw new Error("private I/O detail " + credential) }
      },
      write: (fd, bytes) => {
        if (failed && outcome === "unknown") throw new Error("private rollback detail " + credential)
        return defaultIO.write(fd, bytes)
      },
    } }).then(() => undefined, (reason: unknown) => reason)
    expect(error).toBeInstanceOf(SetupError)
    const message = error instanceof SetupError ? error.message : ""
    expect(message).toContain("Recovery state: " + outcome)
    expect(message).toContain(journal)
    expect(message).toContain(outcome === "rolled-back" ? "cleanup codex" : "recover codex")
    expect(message.includes(credential)).toBe(false)
    expect(message).not.toContain("private I/O detail")
    expect(message).not.toContain("private rollback detail")
    expect(existsSync(journal)).toBe(true)
  } finally { fixture.cleanup() }
})
test("symlink targets and ancestors, wrong home, stale snapshots and held lock are rejected", async () => {
  const fixture = temporaryHome()
  try {
    const prepared = await plan(fixture.home, "claude")
    symlinkSync(fixture.home, join(fixture.home, ".claude"))
    await expect(executeSetup({ allowedHome: fixture.home, plan: prepared })).rejects.toThrow("Symlinks")
    await expect(executeSetup({ allowedHome: fixture.home + "/other", plan: prepared })).rejects.toThrow("home")
  } finally { fixture.cleanup() }
})
