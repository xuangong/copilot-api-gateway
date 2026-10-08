import { join } from "node:path"
import { durableJson } from "../../2026-10-02-workerd-deployed-comparison/harness/journal"
import { fileIdentity } from "../../2026-10-02-workerd-deployed-comparison/harness/manifest"
import type { Inspector } from "../../2026-10-02-workerd-deployed-comparison/harness/inspector"

export type ObserverMode = "none" | "attached" | "cpu"
export interface ObserverConfig { mode: ObserverMode }
export const CPU_INTERVAL_US = 1000
export interface CommandInterval { beginMs: number; endMs: number }
export interface ObserverReceipt {
  mode: ObserverMode
  completed: boolean
  prepared: boolean
  started: boolean
  stopped: boolean
  closeAttempted: boolean
  closed: boolean
  inspector: Inspector["identity"] | null
  intervalUs: number | null
  startCommand: CommandInterval | null
  stopCommand: CommandInterval | null
  v8: { startTime: number; endTime: number } | null
  profile: ReturnType<typeof fileIdentity> | null
  errors: string[]
  scope: string
}
export interface ObserverSession {
  readonly receipt: ObserverReceipt
  prepare(): Promise<void>
  start(): Promise<void>
  stop(): Promise<void>
  close(): Promise<void>
}

export function createObserver(options: { mode: ObserverMode; directory: string; attach(): Promise<Inspector> }): ObserverSession {
  if (!["none", "attached", "cpu"].includes(options.mode)) throw new Error("Invalid observer mode")
  let inspector: Inspector | undefined
  const receipt: ObserverReceipt = { mode: options.mode, completed: false, prepared: false, started: false, stopped: false, closeAttempted: false, closed: false, inspector: null, intervalUs: options.mode === "cpu" ? CPU_INTERVAL_US : null, startCommand: null, stopCommand: null, v8: null, profile: null, errors: [], scope: "observer-inclusive whole-process CPU: processStart before Profiler.start; timed settlement before Profiler.stop; raw profile saved before processEnd; V8 and host/CDP intervals are distinct; no heap queries or source hooks" }
  const requireInspector = () => { if (!inspector) throw new Error("Observer Inspector not prepared"); return inspector }
  const save = () => durableJson(join(options.directory, "observer-receipt.json"), receipt)
  async function guarded(name: string, action: () => Promise<void>) {
    try { await action() } catch (error) { receipt.errors.push(`${name}: ${String(error)}`); receipt.completed = false; save(); throw error }
    save()
  }
  save()
  return {
    receipt,
    prepare() { return guarded("prepare", async () => {
      if (receipt.prepared || receipt.closeAttempted) throw new Error("Observer prepare order invalid")
      if (options.mode !== "none") {
        inspector = await options.attach(); receipt.inspector = inspector.identity
        if (options.mode === "cpu") { await inspector.send("Profiler.enable"); await inspector.send("Profiler.setSamplingInterval", { interval: CPU_INTERVAL_US }) }
      }
      receipt.prepared = true
    }) },
    start() { return guarded("start", async () => {
      if (!receipt.prepared || receipt.started || receipt.closeAttempted) throw new Error("Observer start order invalid")
      if (options.mode === "cpu") {
        const beginMs = performance.now()
        try { await requireInspector().send("Profiler.start") } finally { receipt.startCommand = { beginMs, endMs: performance.now() } }
      }
      receipt.started = true
    }) },
    stop() { return guarded("stop", async () => {
      if (!receipt.started || receipt.stopped || receipt.closeAttempted) throw new Error("Observer stop order invalid")
      if (options.mode === "cpu") {
        const beginMs = performance.now()
        let result: unknown
        try { result = await requireInspector().send("Profiler.stop") } finally { receipt.stopCommand = { beginMs, endMs: performance.now() } }
        const profile = (result as { profile?: unknown })?.profile
        // Preserve the raw successful reply even if its shape later proves invalid.
        durableJson(join(options.directory, "profiler-stop-result.json"), result, true)
        if (profile === undefined) throw new Error("Profiler stop reply lacks profile")
        durableJson(join(options.directory, "profile.cpuprofile"), profile, true)
        receipt.profile = fileIdentity(join(options.directory, "profile.cpuprofile"))
        const times = profile as { startTime?: number; endTime?: number }
        if (typeof times.startTime !== "number" || typeof times.endTime !== "number" || !Number.isFinite(times.startTime) || !Number.isFinite(times.endTime) || times.endTime < times.startTime) throw new Error("Invalid native profile time envelope")
        receipt.v8 = { startTime: times.startTime, endTime: times.endTime }
      }
      receipt.stopped = true
    }) },
    async close() {
      if (receipt.closeAttempted) { if (!receipt.closed) throw new Error("Observer close previously failed"); return }
      receipt.closeAttempted = true
      await guarded("close", async () => { if (inspector) await inspector.close(); receipt.closed = true; receipt.completed = receipt.prepared && receipt.started && receipt.stopped && receipt.errors.length === 0 })
    },
  }
}
