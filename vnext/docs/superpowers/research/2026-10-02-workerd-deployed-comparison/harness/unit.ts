import { join } from "node:path"
import { readFileSync } from "node:fs"
import { Runtime, upstreamFixture } from "./runtime.ts"
import { attach, type Inspector } from "./inspector.ts"
import { cpuSummary, type CpuProfile } from "./cpu.ts"
import { collectionEvidence, durableJson, Journal, readJournal, type CompletionFlags } from "./journal.ts"
import { loadManifest, sha, verifyManifest } from "./manifest.ts"
import { EXPECTED, PROTOCOLS, SCENARIOS, hot, type Variant, type Unit, type Cell } from "./types.ts"

export interface Receipt {
  version: 1; manifestSha256: string; experimentId: string; unit: Unit | "canary"
  expected: number; completed: boolean; fatal: string | null
  evidence: ReturnType<typeof collectionEvidence>; flags: CompletionFlags
}
export async function runUnit(manifestPath: string, output: string, unit: Unit | "canary") {
  const manifest = loadManifest(manifestPath)
  const manifestSha256 = sha(readFileSync(manifestPath))
  const journal = new Journal(join(output, "journal.jsonl"))
  const flags: CompletionFlags = { dispatchExactlyOnce: false, storageReadback: false, backgroundSettled: false, cleanupComplete: false, identitiesMatch: false }
  const expected = unit === "canary" ? 4 : EXPECTED[unit]
  const receiptPath = join(output, "receipt.json")
  const initial: Receipt = { version: 1, manifestSha256, experimentId: manifest.id, unit, expected, completed: false, fatal: null, flags: { ...flags }, evidence: collectionEvidence([], expected, flags) }
  durableJson(receiptPath, initial, true)
  const runtime = new Runtime(manifest, output, journal, unit)
  type Resource = { variant: Variant; phase: string; upstream: Awaited<ReturnType<typeof upstreamFixture>>; active?: Awaited<ReturnType<Runtime["gateway"]>>; inspector?: Inspector }
  const resources: Resource[] = []
  let fatal: string | null = null
  const resource = async (variant: Variant, phase: string) => {
    const upstream = await runtime.stage(`${variant}/fixture`, 5000, upstreamFixture)
    const result: Resource = { variant, phase, upstream }
    resources.push(result)
    result.active = await runtime.gateway(variant, phase, upstream)
    return result
  }
  const offer = async (r: Resource, phase: string, cell: Cell, block = -1) => {
    if (!r.active) throw new Error("Gateway not ready")
    const row = await runtime.request(r.active, r.variant, phase, cell, block)
    if (!row.transportCompleted || phase !== "matrix" && !row.ok) throw new Error(`Request failed ${row.id}: ${row.errors.join(",")}`)
  }
  const settle = async (r: Resource, label: string) => {
    if (!r.active) throw new Error("Gateway not ready")
    const capture = await r.active.settled(label)
    journal.append({ event: "settlement", variant: r.variant, phase: r.phase, ...capture })
  }
  const warm = async (r: Resource) => {
    for (const stream of [false, true]) for (let i = 0; i < 12; i++) await offer(r, `${r.phase}_warmup`, hot(stream))
    await settle(r, "warmup")
  }
  try {
    journal.append({ event: "phase_begin", unit })
    if (unit === "latency-pair") {
      for (const variant of ["A", "B"] as const) await warm(await resource(variant, "latency"))
      for (let block = 0; block < 4; block++) for (const stream of [false, true]) {
        const order = block % 2 === 0 ? resources : [...resources].reverse()
        for (const r of order) {
          journal.append({ event: "block_begin", variant: r.variant, block, stream, phase: "latency" })
          for (let i = 0; i < 10; i++) await offer(r, "latency", hot(stream), block)
          await settle(r, `${stream ? "sse" : "json"}-${block}`)
          journal.append({ event: "block_end", variant: r.variant, block, stream, phase: "latency" })
        }
      }
    } else if (unit === "canary") {
      for (const variant of ["A", "B"] as const) {
        const r = await resource(variant, "canary")
        for (const stream of [false, true]) await offer(r, "canary", hot(stream))
        await settle(r, "ordinary")
        if (!r.active) throw new Error("Gateway not ready")
        r.inspector = await runtime.stage(`${variant}/inspector attach`, 35000, () => attach(() => r.active ? r.active.mf.getInspectorURL() : Promise.reject(new Error("Gateway missing")), r.active?.name ?? "missing"))
        const heap = await r.inspector.send("Runtime.getHeapUsage")
        durableJson(join(r.active.directory, "canary-inspector.json"), { exactTarget: r.active.name, heap }, true)
      }
    } else {
      const variant: Variant = unit.startsWith("A-") ? "A" : "B"
      const phase = unit.endsWith("matrix") ? "matrix" : "diagnostic"
      const r = await resource(variant, phase)
      await warm(r)
      if (phase === "matrix") {
        for (const protocol of PROTOCOLS) for (const upstream of PROTOCOLS) for (const scenario of SCENARIOS) for (const stream of [false, true]) {
          await offer(r, "matrix", { protocol, upstream, scenario, stream, bytes: 65536 })
        }
        await settle(r, "matrix")
      } else {
        if (!r.active) throw new Error("Gateway not ready")
        r.inspector = await runtime.stage(`${variant}/inspector attach`, 35000, () => attach(() => r.active ? r.active.mf.getInspectorURL() : Promise.reject(new Error("Gateway missing")), r.active?.name ?? "missing"))
        await r.inspector.send("Profiler.enable")
        await r.inspector.send("Profiler.setSamplingInterval", { interval: 100 })
        for (const stream of [false, true]) {
          const mode = stream ? "sse" : "json"
          journal.append({ event: "mode_begin", variant, phase, mode })
          const heapStart = await r.inspector.send("Runtime.getHeapUsage")
          await r.inspector.send("Profiler.start")
          for (let i = 0; i < 40; i++) await offer(r, "diagnostic", hot(stream))
          await settle(r, mode)
          const result = await r.inspector.send("Profiler.stop") as { profile: CpuProfile }
          // Persist profile immediately, before further inspector commands.
          durableJson(join(r.active.directory, `${mode}.cpuprofile`), result.profile, true)
          const heapSettled = await r.inspector.send("Runtime.getHeapUsage")
          const summary = { variant, mode, heapStart, heapSettled, cpu: cpuSummary(result.profile, 40) }
          durableJson(join(r.active.directory, `${mode}-diagnostic.json`), summary, true)
          journal.append({ event: "diagnostic", ...summary })
          journal.append({ event: "mode_end", variant, phase, mode })
        }
      }
    }
    for (const r of resources) {
      if (!r.active) throw new Error("Gateway not ready")
      const logical = runtime.rows.filter(row => row.variant === r.variant)
      const offered = new Set(logical.map(row => row.id))
      const dispatchCounts = new Map<string, number>()
      for (const dispatch of r.upstream.dispatches) dispatchCounts.set(dispatch.id, (dispatchCounts.get(dispatch.id) ?? 0) + 1)
      const exactlyOnce = logical.every(row => dispatchCounts.get(row.id) === 1)
      const dispatches = r.upstream.dispatches
      const complete = dispatches.length === logical.length && dispatches.every(d => offered.has(d.id) && d.completed && d.bodyCompleted && !d.cancelled)
      const state = { variant: r.variant, phase: r.phase, exactlyOnce, complete, egress: r.active.egress, dispatches }
      durableJson(join(r.active.directory, "dispatch-readback.json"), state, true)
      journal.append({ event: "dispatch_readback", variant: r.variant, phase: r.phase, exactlyOnce, complete, requests: logical.length })
      if (!exactlyOnce || !complete || r.active.egress.rejected.length || r.active.egress.allowed !== logical.length) throw new Error(`Dispatch/body/egress invariant failed ${r.variant}`)
    }
    flags.dispatchExactlyOnce = true
    flags.storageReadback = true
    flags.backgroundSettled = true
    verifyManifest(manifest)
    if (sha(readFileSync(manifestPath)) !== manifestSha256) throw new Error("Manifest bytes drift")
    flags.identitiesMatch = true
    journal.append({ event: "phase_end", unit })
  } catch (error) {
    fatal = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    journal.append({ event: "unit_error", fatal })
  } finally {
    let cleanupComplete = true
    for (const r of resources.reverse()) {
      for (const cleanup of [async () => { if (r.inspector) await r.inspector.close() }, async () => { if (r.active) await r.active.stop() }, () => r.upstream.stop()]) {
        try { await runtime.stage(`${r.variant}/owned cleanup`, 12000, cleanup) } catch (error) {
          cleanupComplete = false
          fatal ??= error instanceof Error ? error.message : String(error)
        }
      }
    }
    flags.cleanupComplete = cleanupComplete
    journal.append({ event: "cleanup", completed: cleanupComplete })
    journal.close()
  }
  const evidence = collectionEvidence(readJournal(journal.path), expected, flags)
  const receipt: Receipt = { ...initial, flags, fatal, evidence, completed: !fatal && evidence.completed }
  durableJson(receiptPath, receipt)
  return receipt
}
if (import.meta.main) {
  const [manifest, output, unit] = process.argv.slice(2)
  if (!manifest || !output || !unit || !(unit === "canary" || unit in EXPECTED)) throw new Error("Invalid unit CLI")
  if (!process.argv.includes("--run-ready")) throw new Error("Unit requires supervised --run-ready")
  const result = await runUnit(manifest, output, unit as Unit | "canary")
  console.log(JSON.stringify(result))
  if (!result.completed) process.exitCode = 2
}
