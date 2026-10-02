import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { aggregate } from "./aggregate.ts"
import { durableJson } from "./journal.ts"
import { freeze, HARNESS, loadManifest, sha, verifyManifest } from "./manifest.ts"
import { supervise } from "./supervisor.ts"
import { UNITS } from "./types.ts"

const command = process.argv[2]
const args = process.argv.slice(3)
const values = new Map<string, string>()
const switches = new Set<string>()
for (let i = 0; i < args.length; i++) {
  const name = args[i]
  if (!name?.startsWith("--") || values.has(name) || switches.has(name)) throw new Error("Invalid or duplicate CLI argument")
  if (name === "--run-ready") { switches.add(name); continue }
  if (!["--a", "--b", "--out", "--manifest", "--qualification"].includes(name)) throw new Error(`Unknown argument ${name}`)
  const value = args[++i]
  if (!value || value.startsWith("--")) throw new Error(`Missing value ${name}`)
  values.set(name, value)
}
const required = (name: string) => { const value = values.get(`--${name}`); if (!value) throw new Error(`Missing --${name}`); return resolve(value) }
if (command === "freeze") {
  console.log(JSON.stringify({ event: "frozen", manifest: await freeze(required("a"), required("b"), required("out")) }))
} else if (["check", "canary", "run"].includes(command ?? "")) {
  const manifestPath = required("manifest")
  const manifest = loadManifest(manifestPath)
  const manifestSha256 = sha(readFileSync(manifestPath))
  if (command === "check") {
    console.log(JSON.stringify({ completed: true, event: "identities_verified", manifestSha256, experimentId: manifest.id, runtime: manifest.runtime, runtimeNotStarted: true }))
  } else {
    if (!switches.has("--run-ready")) throw new Error("Runtime requires --run-ready after root qualification")
    const canary = command === "canary"
    if (!canary) {
      const qualification = JSON.parse(readFileSync(required("qualification"), "utf8")) as { kind?: string; completed?: boolean; manifestSha256?: string; experimentId?: string }
      if (qualification.kind !== "canary" || qualification.completed !== true || qualification.manifestSha256 !== manifestSha256 || qualification.experimentId !== manifest.id) throw new Error("Formal run requires successful canary for this exact manifest")
    }
    const output = required("out")
    if (existsSync(output)) throw new Error("Run output already exists; never retry into existing evidence")
    mkdirSync(output, { recursive: true, mode: 0o700 })
    const aggregatePath = join(output, "aggregate.json")
    durableJson(aggregatePath, { version: 1, completed: false, manifestSha256, experimentId: manifest.id, kind: canary ? "canary" : "formal", errors: ["Collection not complete"] }, true)
    durableJson(join(output, "manifest-reference.json"), { manifestPath, manifestSha256, experimentId: manifest.id }, true)
    const controller = new AbortController()
    const interrupt = () => controller.abort()
    process.on("SIGINT", interrupt); process.on("SIGTERM", interrupt)
    let fatal: string | null = null
    try {
      for (const unit of canary ? ["canary"] : UNITS) {
        if (controller.signal.aborted) throw new Error("Supervisor interrupted before next unit")
        verifyManifest(manifest)
        const directory = join(output, unit)
        mkdirSync(directory, { mode: 0o700 })
        durableJson(join(directory, "supervision.json"), { completed: false, cleanupComplete: false, event: "supervising" }, true)
        const result = await supervise({ command: process.execPath, args: [join(HARNESS, "unit.ts"), manifestPath, directory, unit, "--run-ready"], directory, timeoutMs: canary ? 240000 : 480000, signal: controller.signal })
        durableJson(join(directory, "supervision.json"), result)
        console.log(JSON.stringify({ event: "child_stopped", unit, ...result }))
        if (result.exitCode !== 0 || result.timedOut || result.interrupted || !result.cleanupComplete || !existsSync(join(directory, "receipt.json"))) throw new Error(`Failed child ${unit}; preserve partial evidence`)
        const receipt = JSON.parse(readFileSync(join(directory, "receipt.json"), "utf8")) as { completed?: boolean }
        if (receipt.completed !== true) throw new Error(`Incomplete receipt ${unit}`)
      }
      if (sha(readFileSync(manifestPath)) !== manifestSha256) throw new Error("Manifest drift after execution")
      const result = aggregate(manifest, manifestSha256, output, canary)
      durableJson(aggregatePath, result)
      console.log(JSON.stringify({ event: "aggregate", completed: result.completed, output, errors: result.errors }))
      if (!result.completed) process.exitCode = 2
    } catch (error) {
      fatal = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      durableJson(aggregatePath, { version: 1, completed: false, manifestSha256, experimentId: manifest.id, kind: canary ? "canary" : "formal", fatal, errors: ["Incomplete collection; original journals remain unmodified"] })
      console.error(fatal)
      process.exitCode = 2
    } finally { process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt) }
  }
} else {
  console.error("Usage: bun run.ts freeze --a ROOT --b ROOT --out NEW_DIR | check --manifest PATH | canary --manifest PATH --out NEW_DIR --run-ready | run --manifest PATH --qualification CANARY/aggregate.json --out NEW_DIR --run-ready")
  process.exitCode = 2
}
