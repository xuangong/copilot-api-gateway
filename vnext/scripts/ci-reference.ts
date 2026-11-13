import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"

export const REFERENCE_REVISION = "1d7dcd923e260e425120cca0c7a240e93720af27"
const REFERENCE_REPOSITORY = "https://github.com/Menci/Floway.git"
export const referenceSourceRoot = resolve(process.env.REFERENCE_SOURCE_ROOT ?? join(homedir(), ".cache/copilot-api-gateway-ci", `reference-${REFERENCE_REVISION}`))

async function run(command: string[], cwd: string, timeout?: number): Promise<void> {
  const child = Bun.spawn(command, { cwd, stdin: "ignore", stdout: "inherit", stderr: "inherit", timeout })
  if (await child.exited !== 0) throw new Error(`CI prerequisite command ${child.signalCode ? "timed out or was killed" : "failed"}: ${command[0]}`)
}

async function output(command: string[], cwd: string): Promise<string> {
  const child = Bun.spawn(command, { cwd, stdin: "ignore", stdout: "pipe", stderr: "ignore" })
  const text = await new Response(child.stdout).text()
  if (await child.exited !== 0) throw new Error(`CI prerequisite command failed: ${command[0]}`)
  return text.trim()
}

/** A checkout counts only at the pinned commit with no tracked file changed. */
async function intact(root: string): Promise<boolean> {
  if (!existsSync(join(root, ".git"))) return false
  try {
    return await output(["git", "rev-parse", "HEAD"], root) === REFERENCE_REVISION
      && await output(["git", "status", "--porcelain", "--untracked-files=no"], root) === ""
  } catch { return false }
}

async function prepareReference(): Promise<void> {
  if (!Bun.which("pwsh")) throw new Error("Full CI requires PowerShell 7 (pwsh) on PATH; see vnext/README.md.")
  if (process.env.REFERENCE_SOURCE_ROOT) {
    if (!existsSync(join(referenceSourceRoot, "node_modules/.modules.yaml"))) throw new Error("REFERENCE_SOURCE_ROOT must contain the pinned reference and its frozen pnpm installation.")
    return
  }
  if (!Bun.which("git")) throw new Error("Full CI requires git on PATH; see vnext/README.md.")
  // Re-verified on every run: an interrupted, edited or older cache is replaced.
  if (!(await intact(referenceSourceRoot))) {
    await rm(referenceSourceRoot, { recursive: true, force: true })
    await mkdir(dirname(referenceSourceRoot), { recursive: true })
    const temporary = await mkdtemp(join(dirname(referenceSourceRoot), "reference-download-"))
    try {
      // Fetch the pinned commit itself: its ID covers every file, while GitHub's
      // generated archives are not promised to stay byte-identical over time.
      const source = join(temporary, "source")
      await run(["git", "init", "--quiet", source], temporary)
      await run(["git", "fetch", "--quiet", "--depth", "1", REFERENCE_REPOSITORY, REFERENCE_REVISION], source, 120_000)
      await run(["git", "checkout", "--quiet", "--detach", "FETCH_HEAD"], source)
      if (!(await intact(source))) throw new Error("Pinned reference commit mismatch")
      // The cache is shared by every worktree; another run may have finished first.
      try { await rename(source, referenceSourceRoot) }
      catch (error) { if (!(await intact(referenceSourceRoot))) throw error }
    } finally { await rm(temporary, { recursive: true, force: true }) }
  }
  // This historical source uses pnpm. Keep its exact dependency graph and
  // lifecycle scripts isolated from the gateway's Bun workspace.
  await run([process.execPath, "x", "pnpm@10.24.0", "install", "--frozen-lockfile", "--ignore-scripts"], referenceSourceRoot)
}

if (import.meta.main) await prepareReference()
