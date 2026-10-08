import { existsSync, mkdirSync } from "node:fs"
import { join, resolve } from "node:path"
import { durableJson } from "../../2026-10-02-workerd-deployed-comparison/harness/journal"
import { fileIdentity } from "../../2026-10-02-workerd-deployed-comparison/harness/manifest"
import { supervise } from "../../2026-10-02-workerd-deployed-comparison/harness/supervisor"

/** Own the entire child group, including workerd and loopback fixture processes. */
export async function runSupervised(mode: "correctness" | "cpu", context: string, output: string) {
  context = resolve(context)
  output = resolve(output)
  const directory = `${output}-supervisor`
  if (existsSync(output) || existsSync(directory)) throw new Error("Run and supervisor outputs must be new")
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const target = join(import.meta.dir, mode === "cpu" ? "coordinator.ts" : "correctness.ts")
  const args = mode === "cpu" ? [target, context, output, "--supervised"] : [target, "--context", context, "--out", output]
  const abort = new AbortController()
  const interrupt = () => abort.abort()
  process.on("SIGINT", interrupt)
  process.on("SIGTERM", interrupt)
  durableJson(join(directory, "inputs.json"), { mode, context: fileIdentity(context), entrypoint: fileIdentity(target), args }, true)
  try {
    const receipt = await supervise({ command: process.execPath, args, directory, timeoutMs: mode === "cpu" ? 1800000 : 600000, signal: abort.signal })
    durableJson(join(directory, "receipt.json"), receipt, true)
    if (receipt.exitCode !== 0 || receipt.timedOut || receipt.interrupted || !receipt.cleanupComplete) throw new Error(`Supervised ${mode} run failed; inspect ${directory}`)
    return receipt
  } finally {
    process.off("SIGINT", interrupt)
    process.off("SIGTERM", interrupt)
  }
}

if (import.meta.main) {
  const [mode, context, output] = process.argv.slice(2)
  if ((mode !== "correctness" && mode !== "cpu") || !context || !output || process.argv.length !== 5) throw new Error("Usage: bun run.ts <correctness|cpu> <context.json> <new-output>")
  console.log(JSON.stringify(await runSupervised(mode, context, output)))
}
