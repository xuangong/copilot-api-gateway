import { createHash, randomUUID } from "node:crypto"
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { execFileSync } from "node:child_process"
import { durableJson } from "./journal.ts"
import { packagePath, verifyResolution, type ResolutionEdge } from "./resolution.ts"
import { supervise } from "./supervisor.ts"

export const HARNESS = realpathSync(import.meta.dir)
export const CANDIDATE = resolve(HARNESS, "../../../../../..")
export const SPEC = join(CANDIDATE, "vnext/docs/superpowers/specs/2026-10-02-workerd-deployed-comparison.md")
export const EXPECTED_A = "e660fb4dfcf1734d10f89e52e2d739b2985c634b"
export const EXPECTED_B = "e90b8ee5a5feb6e99ef45cad8ca4463c245c25e7"
export const sha = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex")
export interface FileIdentity { path: string; bytes: number; sha256: string }
export interface VariantInput { root: string; head: string; files: FileIdentity[]; bundle: string; migrationRoot: string; representation: "deployed-legacy" | "current-v1" }
export interface Manifest {
  version: 1; id: string; createdAt: string
  count: 40; warmup: 12; expected: 716
  variants: Record<"A" | "B", VariantInput>
  execution: FileIdentity
  resolution: ResolutionEdge[]; tools: FileIdentity[]; dependencies: FileIdentity[]; artifacts: FileIdentity[]
  runtime: { bun: string; miniflare: string; workerd: string; wrangler: string; compatibilityDate: "2025-06-01"; compatibilityFlags: ["nodejs_compat"] }
  build: string[]
}
export function fileIdentity(path: string): FileIdentity {
  const bytes = readFileSync(path)
  return { path: resolve(path), bytes: bytes.byteLength, sha256: sha(bytes) }
}
export function verifyFiles(files: FileIdentity[]) {
  for (const expected of files) {
    if (!existsSync(expected.path)) throw new Error(`Input drift: missing ${expected.path}`)
    const actual = fileIdentity(expected.path)
    if (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes) throw new Error(`Input drift: ${expected.path}`)
  }
}
/** Supported execution excludes ambient alternate binaries and debugger bootloaders. */
export function verifyExecution(expected?: FileIdentity): FileIdentity {
  for (const key of ["MINIFLARE_WORKERD_PATH", "VSCODE_INSPECTOR_OPTIONS", "NODE_OPTIONS"]) {
    if (process.env[key] !== undefined) throw new Error(`Unsafe runtime environment: ${key}`)
  }
  if (Bun.version !== "1.3.0") throw new Error("Current Bun version drift")
  const actual = fileIdentity(realpathSync(process.execPath))
  if (expected && (actual.path !== expected.path || actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256)) throw new Error("Current Bun executable drift")
  return actual
}
function walk(root: string, source = false): string[] {
  return readdirSync(root).sort().flatMap(name => {
    const path = join(root, name)
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) return []
    if (stat.isDirectory()) {
      if (["node_modules", ".git", ".wrangler", ".cache", "docs"].includes(name)) return []
      if (source && name === "dist" && !path.includes("/src/")) return []
      return walk(path, source)
    }
    return stat.isFile() ? [path] : []
  })
}
export function sourceFiles(root: string): FileIdentity[] {
  const vnext = join(root, "vnext")
  const paths = ["apps", "packages", "scripts"].flatMap(name => walk(join(vnext, name), true))
  for (const name of readdirSync(vnext)) {
    const path = join(vnext, name)
    if (lstatSync(path).isFile() && /(?:\.jsonc?|\.lockb?|\.toml)$/.test(name)) paths.push(path)
  }
  return paths.sort().map(fileIdentity)
}
function installedDependencies(roots: string[], resolution: ResolutionEdge[]) {
  const visited = new Set<string>()
  const paths = new Set<string>([realpathSync(process.execPath)])
  const visit = (path: string) => {
    const directory = dirname(realpathSync(path))
    if (visited.has(directory)) return
    visited.add(directory)
    for (const file of walk(directory)) paths.add(file)
    const pkg = JSON.parse(readFileSync(path, "utf8")) as { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> }
    for (const name of Object.keys(pkg.dependencies ?? {})) {
      const packageJson = packagePath(name, directory)
      resolution.push({ name, from: directory, packageJson, optional: false })
      visit(packageJson)
    }
    for (const name of Object.keys(pkg.optionalDependencies ?? {})) {
      let packageJson: string | null = null
      try { packageJson = packagePath(name, directory) } catch {}
      resolution.push({ name, from: directory, packageJson, optional: true })
      if (packageJson) visit(packageJson)
    }
  }
  for (const path of roots) visit(path)
  return [...paths].sort().map(fileIdentity)
}
function runtimeInputs(roots: string[]) {
  const vnext = join(CANDIDATE, "vnext")
  const from = [join(vnext, "node_modules"), join(vnext, "apps/platform-cloudflare/node_modules")]
  const miniflare = packagePath("miniflare", from[0] ?? vnext)
  const wrangler = packagePath("wrangler", from[1] ?? vnext)
  const workerd = packagePath("workerd", dirname(miniflare))
  const version = (path: string) => String((JSON.parse(readFileSync(path, "utf8")) as { version: string }).version)
  const runtime: Manifest["runtime"] = { bun: Bun.version, miniflare: version(miniflare), workerd: version(workerd), wrangler: version(wrangler), compatibilityDate: "2025-06-01", compatibilityFlags: ["nodejs_compat"] }
  if (runtime.bun !== "1.3.0" || runtime.miniflare !== "4.20260601.0" || runtime.workerd !== "1.20260601.1" || runtime.wrangler !== "4.97.0") throw new Error("Installed runtime drift")
  const resolution: ResolutionEdge[] = [
    { name: "miniflare", from: from[0] ?? vnext, packageJson: miniflare, optional: false },
    { name: "wrangler", from: from[1] ?? vnext, packageJson: wrangler, optional: false },
    { name: "workerd", from: dirname(miniflare), packageJson: workerd, optional: false },
  ]
  const packages = [miniflare, wrangler, workerd]
  // Include source workspace production dependency graphs used by the Bun build.
  for (const root of roots.slice(-1)) for (const file of sourceFiles(root)) {
    if (!file.path.endsWith("/package.json")) continue
    const pkg = JSON.parse(readFileSync(file.path, "utf8")) as { dependencies?: Record<string, string> }
    for (const [name, range] of Object.entries(pkg.dependencies ?? {})) {
      if (range.startsWith("workspace:") || range.startsWith("file:")) continue
      const packageJson = packagePath(name, dirname(file.path))
      resolution.push({ name, from: dirname(file.path), packageJson, optional: false })
      packages.push(packageJson)
    }
  }
  return { runtime, dependencies: installedDependencies(packages, resolution), resolution }
}
const git = (root: string, args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", timeout: 15000 }).trim()
export async function freeze(a: string, b: string, output: string): Promise<string> {
  const execution = verifyExecution()
  a = realpathSync(a); b = realpathSync(b); output = resolve(output)
  if (existsSync(output)) throw new Error("Freeze output already exists")
  if (git(a, ["rev-parse", "HEAD"]) !== EXPECTED_A) throw new Error("Deployed A HEAD mismatch")
  if (git(a, ["status", "--porcelain", "--untracked-files=normal"])) throw new Error("Deployed A is not clean")
  git(b, ["merge-base", "--is-ancestor", EXPECTED_B, "HEAD"])
  const variants = { A: a, B: b }
  const source = { A: sourceFiles(a), B: sourceFiles(b) }
  const tools = [...walk(HARNESS), SPEC].sort().map(fileIdentity)
  const { runtime, dependencies, resolution } = runtimeInputs([a, b])
  mkdirSync(output, { recursive: true, mode: 0o700 })
  durableJson(join(output, "disposition.json"), { completed: false, event: "freezing" }, true)
  const inputs: Partial<Record<"A" | "B", VariantInput>> = {}
  const build = ["--target=node", "--external=cloudflare:sockets", "--entry-naming=worker.mjs", "--sourcemap=external"]
  for (const variant of ["A", "B"] as const) {
    const directory = join(output, variant)
    mkdirSync(directory, { mode: 0o700 })
    const approved = join(directory, "approved-inputs.json")
    durableJson(approved, [...source[variant], ...dependencies], true)
    verifyExecution(execution)
    const result = await supervise({ command: process.execPath, args: [join(HARNESS, "build.ts"), variants[variant], b, `${directory}/bundle`, approved], directory, timeoutMs: 120000 })
    durableJson(join(directory, "build-receipt.json"), result, true)
    if (result.exitCode !== 0 || !result.cleanupComplete || result.timedOut || result.interrupted) throw new Error(`Matched build failed ${variant}; inspect preserved stderr.log`)
    const moduleEvidence = JSON.parse(readFileSync(join(directory, "resolved-modules.json"), "utf8")) as { records: { edge?: ResolutionEdge }[] }
    for (const record of moduleEvidence.records) if (record.edge) resolution.push(record.edge)
    inputs[variant] = { root: variants[variant], head: git(variants[variant], ["rev-parse", "HEAD"]), files: source[variant], bundle: join(directory, "bundle/worker.mjs"), migrationRoot: join(variants[variant], "vnext/packages/gateway/migrations"), representation: variant === "A" ? "deployed-legacy" : "current-v1" }
  }
  if (!inputs.A || !inputs.B) throw new Error("Incomplete matched builds")
  const artifacts = ["A", "B"].flatMap(variant => [...walk(join(output, variant, "bundle")), join(output, variant, "resolved-modules.json"), join(output, variant, "approved-inputs.json")]).sort().map(fileIdentity)
  const manifest: Manifest = { version: 1, id: randomUUID(), createdAt: new Date().toISOString(), count: 40, warmup: 12, expected: 716, execution, variants: { A: inputs.A, B: inputs.B }, tools, dependencies, artifacts, runtime, build, resolution }
  verifyManifest(manifest)
  const path = join(output, "manifest.json")
  durableJson(path, manifest, true)
  durableJson(join(output, "disposition.json"), { completed: true, event: "frozen", manifestSha256: sha(readFileSync(path)) })
  return path
}
export function loadManifest(path: string): Manifest {
  const value = JSON.parse(readFileSync(path, "utf8")) as Manifest
  if (value.variants?.A?.representation !== "deployed-legacy" || value.variants?.B?.representation !== "current-v1") throw new Error("Invalid declared reader representation")
  if (value.version !== 1 || value.count !== 40 || value.warmup !== 12 || value.expected !== 716 || typeof value.id !== "string" || !value.variants?.A || !value.variants.B) throw new Error("Invalid manifest contract")
  verifyManifest(value)
  return value
}
export function verifyManifest(manifest: Manifest) {
  if (!manifest.execution) throw new Error("Missing frozen Bun executable identity")
  verifyExecution(manifest.execution)
  if (manifest.runtime.bun !== Bun.version) throw new Error("Current Bun version drift")
  verifyResolution(manifest.resolution)
  verifyFiles([...manifest.tools, ...manifest.dependencies, ...manifest.artifacts])
  for (const variant of ["A", "B"] as const) {
    const input = manifest.variants[variant]
    verifyFiles(input.files)
    const fresh = sourceFiles(input.root)
    if (JSON.stringify(fresh) !== JSON.stringify(input.files)) throw new Error(`Source inventory drift ${variant}`)
  }
}
