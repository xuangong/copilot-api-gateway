import { readFileSync } from "node:fs"
import { resolve } from "node:path"

// Run with Bun. This probe reads source and runs isolated GC checks; it changes no source files.
const root = resolve(import.meta.dir, "../../../../..")
const sourcePath = "vnext/packages/chat-flow-kit/src/serve-template.ts"
const base = Bun.spawnSync(["git", "show", `2212683b:${sourcePath}`], { cwd: root })
if (base.exitCode !== 0) throw new Error(base.stderr.toString())
const current = readFileSync(resolve(root, sourcePath), "utf8")
const transpiler = new Bun.Transpiler({ loader: "ts" })
const sourceVersions: [string, string][] = [
  ["base", base.stdout.toString()],
  ["head", current],
  ["head-no-signal", current],
]
const versions: [string, string][] = sourceVersions.map(([label, source]) => [
  label,
  transpiler.transformSync(source).replace(/^export /gm, "") + "; return {serveTemplate};",
])

// This function is also serialized into a fresh Node/V8 process.
async function exercise(
  inputs: [string, string][],
  gc: () => void,
  tick: () => Promise<unknown>,
  runtime: string,
): Promise<void> {
  for (const [label, source] of inputs) {
    const mod = new Function(source)()
    const inbound = new AbortController()
    const signal = label === "head-no-signal" ? undefined : inbound.signal
    const hooks = {
      endpointTag: "gc",
      parse: (input: { raw: unknown }) => input.raw,
      wantsStream: () => false,
      runAttempt: async () => 1,
      respond: async () => new Response("ok"),
    }
    const deps = {
      runQuotaGate: async () => null,
      jsonErrorWrap: () => new Response("error"),
      buildTelemetryCtx: () => ({}),
    }
    const weak = await (async () => {
      const payload = { marker: label }
      const ref = new WeakRef(payload)
      await mod.serveTemplate(hooks, {
        raw: payload, auth: {}, obsCtx: {}, extras: {}, signal,
      }, deps)
      return ref
    })()
    for (let i = 0; i < 10; i++) { await tick(); gc() }
    console.log(JSON.stringify({
      runtime, label, afterServeAlive: weak.deref() !== undefined,
      signalAborted: inbound.signal.aborted,
    }))
    inbound.abort()
    for (let i = 0; i < 10; i++) { await tick(); gc() }
    console.log(JSON.stringify({
      runtime, label, afterAbortAlive: weak.deref() !== undefined,
      signalAborted: inbound.signal.aborted,
    }))
  }
}

await exercise(versions, () => Bun.gc(true), () => Bun.sleep(0), `Bun ${Bun.version}`)
const child = Bun.spawnSync([
  "node", "--expose-gc", "-e",
  `(${exercise.toString()})(${JSON.stringify(versions)}, global.gc, () => new Promise(r => setImmediate(r)), process.version).catch(e => { console.error(e); process.exitCode = 1 })`,
])
process.stdout.write(child.stdout)
if (child.exitCode !== 0) {
  process.stderr.write(child.stderr)
  process.exitCode = child.exitCode
}
