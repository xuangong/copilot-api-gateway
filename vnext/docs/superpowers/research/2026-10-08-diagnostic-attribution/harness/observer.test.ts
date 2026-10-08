import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createObserver } from "./observer"
import { freezeObserverPlan, validateObserverJob } from "./runner"

const profile = { nodes: [{ id: 1, callFrame: { functionName: "(root)", url: "", lineNumber: -1, columnNumber: -1 } }], startTime: 1, endTime: 2, samples: [1], timeDeltas: [1] }
async function withObserver(mode: "none" | "attached" | "cpu", run: (observer: ReturnType<typeof createObserver>, events: string[], directory: string) => Promise<void>, fail?: string) {
  const directory = mkdtempSync(join(tmpdir(), "observer-life-")), events: string[] = []
  const inspector = { identity: { inspectorURL: "ws://localhost:1", target: { id: "core:user:exact" } }, async send(method: string) { events.push(method); if (method === fail) throw new Error("injected"); return method === "Profiler.stop" ? { profile } : {} }, async close() { events.push("close"); if (fail === "close") throw new Error("injected close") } }
  const observer = createObserver({ mode, directory, async attach() { events.push("attach"); return inspector } })
  try { await run(observer, events, directory) } finally { rmSync(directory, { recursive: true, force: true }) }
}
test("none sends no inspector commands; attached sends no profiler commands", async () => {
  for (const mode of ["none", "attached"] as const) await withObserver(mode, async (o, events) => {
    await o.prepare(); await o.start(); await o.stop(); await o.close()
    expect(events).toEqual(mode === "none" ? [] : ["attach", "close"])
    expect(o.receipt.completed).toBe(true)
  })
})
test("CPU prepare/start/stop/close ordering and raw profile precede subsequent work", async () => {
  await withObserver("cpu", async (o, events, directory) => {
    await o.prepare(); events.push("processStart"); await o.start(); events.push("offers", "settled"); await o.stop()
    expect(JSON.parse(readFileSync(join(directory, "profile.cpuprofile"), "utf8"))).toEqual(profile)
    const start = o.receipt.startCommand
    if (!start) throw new Error("Missing CPU start interval")
    expect(start.endMs).toBeGreaterThanOrEqual(start.beginMs)
    events.push("processEnd"); await o.close()
    expect(events).toEqual(["attach", "Profiler.enable", "Profiler.setSamplingInterval", "processStart", "Profiler.start", "offers", "settled", "Profiler.stop", "processEnd", "close"])
    expect(o.receipt.completed).toBe(true)
  })
})
test("start, stop and close failures can never complete the observer", async () => {
  for (const failure of ["Profiler.start", "Profiler.stop", "close"]) await withObserver("cpu", async o => {
    await o.prepare()
    if (failure === "Profiler.start") await expect(o.start()).rejects.toThrow("injected")
    else { await o.start(); if (failure === "Profiler.stop") await expect(o.stop()).rejects.toThrow("injected"); else await o.stop() }
    if (failure === "close") await expect(o.close()).rejects.toThrow("injected")
    else await o.close()
    expect(o.receipt.completed).toBe(false)
    expect(o.receipt.errors.length).toBeGreaterThan(0)
  }, failure)
})
test("fixed B JSON observer plan has exactly twelve ordered windows and 420 offers", () => {
  const p = freezeObserverPlan()
  expect(p.windows.length).toBe(12)
  expect(p.windows.map(w => w.observer.mode)).toEqual(["none", "attached", "cpu", "none", "attached", "cpu", "cpu", "attached", "none", "cpu", "attached", "none"])
  expect(p.windows.reduce((n, w) => n + w.warmup + w.timed, 0)).toBe(420)
  expect(p.windows.every(w => w.arm === "B" && !w.cell.stream && w.warmup === 5 && w.timed === 30)).toBe(true)
})
test("child rejects altered job, context, window, directory and parent ownership", () => {
  const window = freezeObserverPlan().windows[0], contextBytes = Buffer.from('{"frozen":true}')
  if (!window) throw new Error("Missing fixed test window")
  const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")
  const job = { version: 1, kind: "observer-window", directory: "/owned/window", parentPid: 123, context: { path: "/owned/context.json", sha256: digest(contextBytes) }, window }
  const bytes = Buffer.from(JSON.stringify(job))
  expect(validateObserverJob(bytes, digest(bytes), contextBytes, "/owned/window/instance-job.json", 123, 123).window).toEqual(window)
  for (const [changed, parent, group, context] of [[{ ...job, directory: "/wrong" },123,123,contextBytes],[{...job,window:{...window,timed:29}},123,123,contextBytes],[job,124,123,contextBytes],[job,123,124,contextBytes],[job,123,123,Buffer.from("{}")]] as const) {
    const raw = Buffer.from(JSON.stringify(changed))
    expect(() => validateObserverJob(raw,digest(raw),context,"/owned/window/instance-job.json",parent,group)).toThrow()
  }
  expect(() => validateObserverJob(bytes,"f".repeat(64),contextBytes,"/owned/window/instance-job.json",123,123)).toThrow()
})

test("successful stop artifacts survive later envelope rejection", async () => {
  const directory = mkdtempSync(join(tmpdir(), "observer-partial-"))
  const malformed = { ...profile, endTime: "invalid" }
  const observer = createObserver({ mode: "cpu", directory, async attach() { return { identity: { inspectorURL: "ws://localhost:1", target: { id: "core:user:exact" } }, async send(method) { return method === "Profiler.stop" ? { profile: malformed } : {} }, async close() {} } } })
  try {
    await observer.prepare(); await observer.start()
    await expect(observer.stop()).rejects.toThrow("time envelope")
    expect(JSON.parse(readFileSync(join(directory, "profile.cpuprofile"), "utf8"))).toEqual(malformed)
    expect(JSON.parse(readFileSync(join(directory, "profiler-stop-result.json"), "utf8"))).toEqual({ profile: malformed })
    await observer.close()
    expect(observer.receipt.completed).toBe(false)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
test("out-of-order lifecycle is rejected and cannot complete even after cleanup", async () => {
  await withObserver("none", async o => {
    await expect(o.start()).rejects.toThrow("order")
    await o.prepare(); await o.start(); await o.stop(); await o.close()
    expect(o.receipt.completed).toBe(false)
  })
})

test("setup read/write/build/Miniflare failures always stop the owned fixture and retain cleanup", async () => {
  const { runQualifiedInstance } = await import("../../2026-10-07-reference-stage-measurement/harness/runtime")
  const cell = freezeObserverPlan().windows[0]?.cell
  if (!cell) throw new Error("Missing fixed test cell")
  for (const stage of ["read", "write", "build", "miniflare"] as const) for (const cleanupFails of [false, true]) {
    const directory = mkdtempSync(join(tmpdir(), "observer-setup-"))
    let stops = 0
    const runError = new Error(`injected ${stage}`)
    const fail = () => { throw runError }
    try {
      await expect(runQualifiedInstance({ arm: "B", bundle: "/frozen/worker.mjs", directory, hooks: false, observer: { mode: "cpu" }, window: { id: "setup-test", cell, warmup: 5, timed: 30 }, async initialize() {}, async readback() { throw new Error("Unexpected readback") } }, {
        fixture: () => ({ base: "http://127.0.0.1:1", dispatches: [], stop: async () => { stops++; if (cleanupFails) throw new Error("injected cleanup") } }),
        readTemplate: stage === "read" ? fail : () => "export default {}",
        writeEntry: stage === "write" ? fail : () => {},
        buildEntry: stage === "build" ? async () => fail() : async () => ({ success: true, logs: [] }),
        createMiniflare: fail,
      })).rejects.toBe(runError)
      expect(stops).toBe(1)
      const receipt = JSON.parse(readFileSync(join(directory, "cleanup-receipt.json"), "utf8"))
      expect(receipt.completed).toBe(false)
      expect(receipt.fixtureStopped).toBe(!cleanupFails)
      expect(receipt.workerdCreated).toBe(false)
      expect(receipt.runError).toContain(`injected ${stage}`)
      expect(receipt.errors).toEqual(cleanupFails ? ["fixture stop: Error: injected cleanup"] : [])
      expect(existsSync(join(directory, "receipt.json"))).toBe(false)
    } finally { rmSync(directory, { recursive: true, force: true }) }
  }
})
