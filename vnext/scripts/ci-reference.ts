import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"

export const REFERENCE_REVISION = "1d7dcd923e260e425120cca0c7a240e93720af27"
const ARCHIVE_SHA256 = "5741b00c9035812958584455ec6b153c6bef3407464c443dd126cb6822752d17"
export const referenceSourceRoot = resolve(process.env.REFERENCE_SOURCE_ROOT ?? join(homedir(), ".cache/copilot-api-gateway-ci", `reference-${REFERENCE_REVISION}`))

async function run(command: string[], cwd: string): Promise<void> {
  const child = Bun.spawn(command, { cwd, stdin: "ignore", stdout: "inherit", stderr: "inherit" })
  if (await child.exited !== 0) throw new Error(`CI prerequisite command failed: ${command[0]}`)
}

async function prepareReference(): Promise<void> {
  if (!Bun.which("pwsh")) throw new Error("Full CI requires PowerShell 7 (pwsh) on PATH; see vnext/README.md.")
  if (process.env.REFERENCE_SOURCE_ROOT) {
    if (!existsSync(join(referenceSourceRoot, "node_modules/.modules.yaml"))) throw new Error("REFERENCE_SOURCE_ROOT must contain the pinned reference and its frozen pnpm installation.")
    return
  }
  if (!existsSync(referenceSourceRoot)) {
    await mkdir(dirname(referenceSourceRoot), { recursive: true })
    const temporary = await mkdtemp(join(dirname(referenceSourceRoot), "reference-download-"))
    try {
      const response = await fetch(`https://codeload.github.com/Menci/Floway/tar.gz/${REFERENCE_REVISION}`, { signal: AbortSignal.timeout(120_000) })
      if (!response.ok) throw new Error(`Reference archive download failed: HTTP ${response.status}`)
      const bytes = new Uint8Array(await response.arrayBuffer())
      if (createHash("sha256").update(bytes).digest("hex") !== ARCHIVE_SHA256) throw new Error("Pinned reference archive checksum mismatch")
      const archive = join(temporary, "source.tar.gz")
      const source = join(temporary, "source")
      await Bun.write(archive, bytes)
      await mkdir(source)
      await run(["tar", "-xzf", archive, "--strip-components=1", "-C", source], temporary)
      await rename(source, referenceSourceRoot)
    } finally { await rm(temporary, { recursive: true, force: true }) }
  }
  // This historical source uses pnpm. Keep its exact dependency graph and
  // lifecycle scripts isolated from the gateway's Bun workspace.
  await run([process.execPath, "x", "pnpm@10.24.0", "install", "--frozen-lockfile", "--ignore-scripts"], referenceSourceRoot)
}

if (import.meta.main) await prepareReference()
