import { execFileSync } from "node:child_process"
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { randomUUID } from "node:crypto"
import { fileIdentity, sha, sourceFiles, verifyExecution, verifyFiles, type Manifest } from "../../2026-10-02-workerd-deployed-comparison/harness/manifest"
import { matchedBuild } from "../../2026-10-02-workerd-deployed-comparison/harness/build"
import { verifyResolution } from "../../2026-10-02-workerd-deployed-comparison/harness/resolution"
import { durableJson } from "../../2026-10-02-workerd-deployed-comparison/harness/journal"
import { buildReference } from "../../2026-10-07-reference-stage-measurement/harness/reference-adapter"

const B_HEAD = "963305f85654ff9b4fac28132739ec7ec9902e9a"
const R_HEAD = "1d7dcd923e260e425120cca0c7a240e93720af27"
const git = (root: string, args: string[]) => execFileSync("git", ["-C", root, ...args], { maxBuffer: 256 * 1024 * 1024 })

/** New B/R identities; the old manifest supplies installed dependency identities only. */
export async function freezeMatchedInputs(options: { candidate: string; reference: string; referenceSource: string; dependencyManifest: string; output: string }) {
  const { candidate, reference, referenceSource, dependencyManifest } = options
  const output = resolve(options.output)
  if (existsSync(output)) throw new Error("Matched freeze output already exists")
  if (git(candidate, ["rev-parse", "HEAD"]).toString().trim() !== B_HEAD) throw new Error("B HEAD changed")
  if (git(reference, ["rev-parse", "HEAD"]).toString().trim() !== R_HEAD || git(reference, ["status", "--porcelain"]).length) throw new Error("R must match the clean frozen commit")
  const prior = JSON.parse(readFileSync(dependencyManifest, "utf8")) as Manifest
  verifyExecution(prior.execution)
  verifyResolution(prior.resolution.filter(edge => edge.from.includes("/node_modules/")))
  verifyFiles(prior.dependencies)
  mkdirSync(output, { recursive: true, mode: 0o700 })
  const source = join(output, "B-source")
  mkdirSync(source)
  const archive = git(candidate, ["archive", "--format=tar", B_HEAD])
  execFileSync("tar", ["-xf", "-", "-C", source], { input: archive })
  const tracked = git(candidate, ["ls-tree", "-r", "--name-only", B_HEAD]).toString().trim().split("\n")
  const trackedIdentities = tracked.map(path => fileIdentity(join(source, path)))
  // Only ignored generated source assets may supplement the tracked archive.
  const missing = sourceFiles(candidate).filter(file => !existsSync(join(source, relative(candidate, file.path))))
  let ignored: string[] = []
  if (missing.length) {
    try { ignored = execFileSync("git", ["-C", candidate, "check-ignore", "--stdin"], { input: missing.map(file => relative(candidate, file.path)).join("\n"), encoding: "utf8" }).trim().split("\n") } catch (error) {
      if ((error as { status?: number }).status !== 1) throw error
    }
  }
  const generated = missing.filter(file => ignored.includes(relative(candidate, file.path)))
  for (const file of generated) {
    const destination = join(source, relative(candidate, file.path))
    mkdirSync(dirname(destination), { recursive: true })
    cpSync(file.path, destination)
  }
  // Verify every tracked reference byte against the commit, without another install or checkout.
  const referenceTracked = git(reference, ["ls-tree", "-r", "--name-only", R_HEAD]).toString().trim().split("\n")
  const referenceLinks: { path: string; target: string; sha256: string }[] = []
  const referenceFiles = referenceTracked.flatMap(path => {
    const expected = git(reference, ["show", `${R_HEAD}:${path}`])
    const destination = join(referenceSource, path)
    if (lstatSync(destination).isSymbolicLink()) {
      const target = readlinkSync(destination)
      if (sha(target) !== sha(expected)) throw new Error(`Reference archive symlink drift: ${path}`)
      referenceLinks.push({ path: destination, target, sha256: sha(target) })
      return []
    }
    const actual = fileIdentity(join(referenceSource, path))
    if (sha(expected) !== actual.sha256) throw new Error(`Reference archive drift: ${path}`)
    return [actual]
  })
  durableJson(join(output, "source-receipt.json"), { B: { head: B_HEAD, archiveSha256: sha(archive), tracked: trackedIdentities, generated }, R: { head: R_HEAD, root: referenceSource, tracked: referenceFiles, symlinks: referenceLinks }, excluded: "uncommitted product changes; no installation; inherited A metadata is unused" }, true)
  const files = sourceFiles(source)
  const approved = [...files, ...prior.dependencies]
  const bDirectory = join(output, "B-build")
  mkdirSync(bDirectory)
  durableJson(join(bDirectory, "approved-inputs.json"), approved, true)
  verifyFiles(approved)
  await matchedBuild(source, candidate, join(bDirectory, "bundle"), approved)
  verifyFiles(approved)
  const referenceBuild = await buildReference(referenceSource, join(output, "R-build"))
  verifyFiles(referenceFiles)
  verifyFiles(referenceBuild.inputs.map(input => ({ ...input, bytes: readFileSync(input.path).length })))
  const bundle = join(bDirectory, "bundle/worker.mjs")
  const manifest: Manifest = {
    ...prior, id: randomUUID(), createdAt: new Date().toISOString(),
    variants: { A: prior.variants.A, B: { root: source, head: B_HEAD, files, bundle, migrationRoot: join(source, "vnext/packages/gateway/migrations"), representation: "current-v1" } },
    tools: [], artifacts: [bundle, referenceBuild.bundle, join(bDirectory, "resolved-modules.json"), join(output, "R-build/reference-build-receipt.json")].map(fileIdentity),
  }
  durableJson(join(output, "context.json"), { schema: "matched-sse-inputs-v1", manifest, referenceRoot: referenceSource, reference: referenceBuild, identities: { B: B_HEAD, R: R_HEAD }, adapterOnly: "A/count/warmup/expected inherited fields are not experiment inputs; authoritative population is the new matched plan" }, true)
  verifyFiles([...files, ...prior.dependencies, ...manifest.artifacts, ...trackedIdentities, ...referenceFiles])
  for (const link of referenceLinks) if (readlinkSync(link.path) !== link.target) throw new Error(`Reference symlink changed during build: ${link.path}`)
  return join(output, "context.json")
}

if (import.meta.main) {
  const [candidate, reference, referenceSource, dependencyManifest, output] = process.argv.slice(2)
  if (!candidate || !reference || !referenceSource || !dependencyManifest || !output) throw new Error("freeze.ts requires candidate reference reference-source dependency-manifest new-output")
  console.log(await freezeMatchedInputs({ candidate, reference, referenceSource, dependencyManifest, output }))
}
