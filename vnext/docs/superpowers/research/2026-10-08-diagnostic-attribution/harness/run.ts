import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { durableJson } from "../../2026-10-02-workerd-deployed-comparison/harness/journal"
import { fileIdentity, loadManifest, sha, verifyFiles } from "../../2026-10-02-workerd-deployed-comparison/harness/manifest"
import { createRequire } from "node:module"
import { supervise } from "../../2026-10-02-workerd-deployed-comparison/harness/supervisor"

/** Freeze the exact Bun-loaded UMD runtime closure used by profile.ts. */
export function freezeMappingRuntimeInputs() {
  const libraryRoot = resolve(import.meta.dir, "../../../../../node_modules/.bun/@jridgewell+trace-mapping@0.3.31/node_modules/@jridgewell/trace-mapping")
  const resolver = createRequire(import.meta.path)
  const trace = realpathSync(resolver.resolve(libraryRoot))
  const specifications = [
    { name: "@jridgewell/trace-mapping", version: "0.3.31", entry: trace, dependencies: ["@jridgewell/resolve-uri", "@jridgewell/sourcemap-codec"] },
    ...[{ name: "@jridgewell/resolve-uri", version: "3.1.2" }, { name: "@jridgewell/sourcemap-codec", version: "1.5.5" }].map(spec => ({ ...spec, entry: realpathSync(createRequire(trace).resolve(spec.name)), dependencies: [] as string[] })),
  ]
  return specifications.flatMap(spec => {
    const packagePath = join(dirname(dirname(spec.entry)), "package.json")
    const metadata = JSON.parse(readFileSync(packagePath, "utf8")) as { name: string; version: string; dependencies?: Record<string, string> }
    if (metadata.name !== spec.name || metadata.version !== spec.version || JSON.stringify(Object.keys(metadata.dependencies ?? {}).sort()) !== JSON.stringify([...spec.dependencies].sort())) throw new Error(`Mapping runtime package identity/closure changed: ${spec.name}`)
    const source = readFileSync(spec.entry, "utf8")
    const requires = [...source.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map(match => match[1]).sort()
    if (JSON.stringify(requires) !== JSON.stringify([...spec.dependencies].sort()) || !spec.entry.endsWith(`/dist/${spec.name.split("/").at(-1)}.umd.js`)) throw new Error(`Mapping runtime JS resolution/closure changed: ${spec.name}`)
    return [fileIdentity(spec.entry), fileIdentity(packagePath)]
  })
}

if (import.meta.main) {
  const args = process.argv.slice(2), options = new Map<string, string>()
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1]
    if (!key || !["--manifest", "--out"].includes(key) || options.has(key) || !value || value.startsWith("--")) throw new Error("Use bun run.ts --manifest PATH --out NEW_DIR")
    options.set(key, resolve(value))
  }
  const manifestPath = options.get("--manifest"), output = options.get("--out")
  if (!manifestPath || !output || existsSync(output)) throw new Error("Missing arguments or output already exists; preserve evidence")
  const manifest = loadManifest(manifestPath)
  if (manifest.id !== "05f341af-02b0-4c30-8c5d-9958b29ac722") throw new Error("Observer experiment requires its declared frozen A/B manifest")
  mkdirSync(output, { recursive: true, mode: 0o700 })
  const dirs = [import.meta.dir, resolve(import.meta.dir, "../../2026-10-07-reference-stage-measurement/harness"), resolve(import.meta.dir, "../../2026-10-02-workerd-deployed-comparison/harness")]
  const harness = dirs.flatMap(dir => readdirSync(dir).filter(name => /\.(ts|py|template|json)$/.test(name)).map(name => fileIdentity(join(dir, name))))
  const mappingRuntimeInputs = freezeMappingRuntimeInputs()
  const inputs = [...mappingRuntimeInputs, ...harness, ...manifest.variants.B.files, ...manifest.dependencies, ...manifest.artifacts, fileIdentity(manifestPath)]
  const frozenManifest = join(output, "frozen-manifest.json")
  durableJson(frozenManifest, manifest, true)
  inputs.push(fileIdentity(frozenManifest))
  durableJson(join(output, "inputs.json"), { manifestPath, manifestSha256: sha(readFileSync(manifestPath)), experimentId: manifest.id, harness, mappingRuntimeInputs, inputs, runtime: manifest.runtime, compatibilityDate: "2025-06-01", compatibilityFlags: ["nodejs_compat", "enable_ctx_exports"], scope: "bounded B-only JSON observer qualification; no noise bound, source hooks or heap queries" }, true)
  durableJson(join(output, "supervision.json"), { completed: false, cleanupComplete: false }, true)
  const abort = new AbortController(), interrupt = () => abort.abort()
  process.on("SIGINT", interrupt); process.on("SIGTERM", interrupt)
  try {
    verifyFiles(inputs)
    const result = await supervise({ command: process.execPath, args: [join(import.meta.dir, "runner.ts"), "--coordinator", frozenManifest, output], directory: output, timeoutMs: 1200000, signal: abort.signal })
    durableJson(join(output, "supervision.json"), result)
    if (result.exitCode !== 0 || result.timedOut || result.interrupted || !result.cleanupComplete) throw new Error("Observer collection failed; preserve logs/partial evidence")
    const disposition = JSON.parse(readFileSync(join(output, "disposition.json"), "utf8")) as { completed: boolean; observerComparisonCompleted: boolean }
    if (disposition.completed !== true || disposition.observerComparisonCompleted !== true) throw new Error("Observer collection incomplete")
    verifyFiles(inputs)
    durableJson(join(output, "result.json"), { completed: true, observerComparisonCompleted: true, comparisonCompleted: false, independentlyAnalyzed: false, supervision: result }, true)
    console.log(JSON.stringify({ completed: true, observerComparisonCompleted: true, comparisonCompleted: false, output }))
  } catch (error) {
    durableJson(join(output, "result.json"), { completed: false, observerComparisonCompleted: false, comparisonCompleted: false, error: String(error) })
    process.exitCode = 2
  } finally { process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt) }
}
