import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { coverage, hookTargets, patchSource, type Arm } from "./instrumentation.ts"

const roots: Record<Arm, string | undefined> = {
  A: process.env.MEASUREMENT_SOURCE_A,
  B: process.env.MEASUREMENT_SOURCE_B,
  R: process.env.MEASUREMENT_SOURCE_R,
}
// These tests qualify the historical transforms, whose hashes deliberately do
// not follow product changes. Checked-in bytes also work in shallow checkouts.
const fixtureRoot = resolve(import.meta.dir, "fixtures/instrumentation-source")
const sourceAt = (arm: Arm, path: string) => {
  const root = roots[arm]
  return readFileSync(root === undefined ? resolve(fixtureRoot, arm, `${path}.txt`) : resolve(root, path), "utf8")
}
const probeKey = Symbol.for("gateway.measurement.probe")
const globalProbe = globalThis as unknown as Record<symbol, unknown>
const oldProbe = globalProbe[probeKey]
afterEach(() => {
  if (oldProbe === undefined) delete globalProbe[probeKey]
  else globalProbe[probeKey] = oldProbe
})

describe("measurement-only source instrumentation", () => {
  test("checked-in source fixtures retain their complete frozen identities", () => {
    const manifest = JSON.parse(readFileSync(resolve(fixtureRoot, "manifest.json"), "utf8")) as {
      schema: string
      arms: Record<Arm, { commit: string; files: { path: string; fixture: string; bytes: number; sha256: string }[] }>
    }
    expect(manifest.schema).toBe("measurement-instrumentation-test-source-v1")
    for (const arm of ["A", "B", "R"] as const) {
      const source = manifest.arms[arm]
      expect(source.commit).toMatch(/^[a-f0-9]{40}$/)
      expect(source.files.map(file => file.path).sort()).toEqual(hookTargets(arm).sort())
      for (const file of source.files) {
        expect(file.fixture).toBe(`${arm}/${file.path}.txt`)
        const bytes = readFileSync(resolve(fixtureRoot, file.fixture))
        expect(bytes.byteLength).toBe(file.bytes)
        expect(createHash("sha256").update(bytes).digest("hex")).toBe(file.sha256)
        expect(patchSource(arm, file.path, bytes.toString("utf8")).applied.length).toBeGreaterThan(0)
      }
    }
  })

  test("all three arms expose the required common Chat route and direct fetch hooks", () => {
    for (const arm of ["A", "B"] as const) {
      expect(hookTargets(arm)).toContain("packages/gateway/src/data-plane/chat-flow/chat-completions/http.ts")
      expect(hookTargets(arm)).toContain("packages/upstream/src/fetcher.ts")
    }
    expect(hookTargets("R")).toContain("packages/gateway/src/data-plane/chat/openai-chat-completions/http.ts")
    expect(hookTargets("R")).toContain("apps/platform-cloudflare/src/fetch.ts")
  })

  test("an unrelated source is returned without inserting any runtime code", () => {
    expect(patchSource("B", "packages/unrelated.ts", "export const x = 1")).toEqual({ source: "export const x = 1", applied: [] })
  })

  test("a frozen target rejects source drift and duplicate operation anchors", () => {
    const path = "packages/upstream/src/fetcher.ts"
    const source = sourceAt("B", path)
    expect(() => patchSource("B", path, `${source}\n// unrelated source drift\n`)).toThrow(/source drift/)
    expect(() => patchSource("B", path, `${source}\n${source}`)).toThrow(/expected 1.*found 2/)
  })

  test("all frozen transforms compile without adding async work, stream consumers, or serialization", () => {
    const transpiler = new Bun.Transpiler({ loader: "ts", target: "browser" })
    for (const arm of ["A", "B", "R"] as const) {
      const targets = hookTargets(arm)
      expect(targets.length).toBeGreaterThan(5)
      for (const path of targets) {
        const source = sourceAt(arm, path)
        const patched = patchSource(arm, path, source)
        expect(patched.applied.length).toBeGreaterThan(0)
        expect(() => transpiler.transformSync(patched.source)).not.toThrow()
        for (const pattern of [/\bawait\b/g, /\.then\(/g, /\.catch\(/g, /\.finally\(/g, /\.getReader\(/g, /\.tee\(/g, /\.read\(/g, /JSON\.stringify\(/g, /\.encode\(/g]) {
          expect(patched.source.match(pattern)?.length ?? 0).toBe(source.match(pattern)?.length ?? 0)
        }
        expect(() => patchSource(arm, path, patched.source)).toThrow()
      }
    }
  })

  test("coverage distinguishes missing observations and unlike units from zero cost", () => {
    expect(coverage("B").supported).toContain("compression.input.codeUnits")
    expect(coverage("R").supported).not.toContain("configuration.copy.calls")
    expect(coverage("R").missing.join(" ")).toContain("absence is not zero cost")
    expect(coverage("B").missing.join(" ")).toContain("not request settlement")
    for (const arm of ["A", "B", "R"] as const) {
      expect(coverage(arm).missing.join(" ")).toContain("no extra Promise reaction")
      expect(coverage(arm).qualifications.join(" ")).toContain("not an exact network-header timestamp")
    }
  })

  test("configuration-copy instrumentation preserves cloning, cycles, aliases and synchronous clone errors", () => {
    const path = "packages/gateway/src/repo/configuration-cache.ts"
    for (const arm of ["A", "B"] as const) {
      const patched = patchSource(arm, path, sourceAt(arm, path)).source
      const helper = patched.slice(0, patched.indexOf("\n\n"))
      const copyLine = patched.match(/^const copy = .+$/m)?.[0]
      expect(copyLine).toBeDefined()
      const code = new Bun.Transpiler({ loader: "ts" }).transformSync(`${helper}\n${copyLine}`)
      const copy = new Function(`${code}\nreturn copy`)() as <T>(value: T) => T
      const child = { name: "preserve" }
      const source: { left: typeof child; right: typeof child; self?: unknown } = { left: child, right: child }
      source.self = source
      const calls: unknown[][] = []
      globalProbe[probeKey] = (...args: unknown[]) => { calls.push(args) }
      const cloned = copy(source)
      expect(cloned).not.toBe(source)
      expect(cloned.left).not.toBe(child)
      expect(cloned.left).toBe(cloned.right)
      expect(cloned.self).toBe(cloned)
      expect(calls).toEqual([["count", "configuration.copy.calls", 1]])
      expect(() => copy(() => {})).toThrow()
    }
  })

  test("parser hooks preserve frame output, source demand, EOF and cancellation", async () => {
    const path = "packages/result/src/parse-sse.ts"
    type Frame = { data: string; event?: string }
    type Parse = (stream: ReadableStream<Uint8Array>) => AsyncGenerator<Frame>
    const evaluate = (source: string): Parse => {
      const code = new Bun.Transpiler({ loader: "ts" }).transformSync(source.replace(/^import .+\n/m, ""))
      return new Function("sseFrame", `${code.replace("export const parseSSEStream", "const parseSSEStream")}\nreturn parseSSEStream`)((data: string, event?: string) => ({ data, event })) as Parse
    }
    const run = async (parse: Parse, earlyReturn: boolean) => {
      const receipts: string[] = []
      const chunks = ["data: one\n\n", "data: two\n\n", "data: [DONE]\n\n"]
      let cursor = 0
      const source = new ReadableStream<Uint8Array>({
        pull(controller) {
          receipts.push(`pull:${cursor}`)
          if (cursor === chunks.length) controller.close()
          else controller.enqueue(new TextEncoder().encode(chunks[cursor++]!))
        },
        cancel() { receipts.push("cancel") },
      }, { highWaterMark: 0 })
      const frames: Frame[] = []
      for await (const frame of parse(source)) {
        frames.push(frame)
        if (earlyReturn) break
      }
      return { receipts, frames }
    }
    for (const arm of ["A", "B"] as const) {
      const source = sourceAt(arm, path)
      const original = evaluate(source)
      const patched = evaluate(patchSource(arm, path, source).source)
      for (const earlyReturn of [false, true]) {
        delete globalProbe[probeKey]
        const baseline = await run(original, earlyReturn)
        const counts: Record<string, number> = {}
        globalProbe[probeKey] = (kind: string, name: string, amount: number) => {
          if (kind === "count") counts[name] = (counts[name] ?? 0) + amount
        }
        expect(await run(patched, earlyReturn)).toEqual(baseline)
        expect(counts["sse.parsed.frames"]).toBe(earlyReturn ? 1 : 3)
        expect(counts["sse.input.chunks"]).toBe(earlyReturn ? 1 : 3)
      }
    }
  })

  test("the actual direct-fetch transform preserves the returned promise, sync throws, and callback isolation", async () => {
    const path = "packages/upstream/src/fetcher.ts"
    const patched = patchSource("B", path, sourceAt("B", path))
    const js = new Bun.Transpiler({ loader: "ts" }).transformSync(patched.source)
    const directFetcher = new Function(`${js.replace("export const directFetcher", "const directFetcher")}\nreturn directFetcher`)() as (url: string, init: RequestInit) => Promise<Response>
    const originalFetch = globalThis.fetch
    const responsePromise = Promise.resolve(new Response("ok"))
    const calls: unknown[][] = []
    try {
      globalThis.fetch = Object.assign(() => responsePromise, { preconnect: originalFetch.preconnect })
      globalProbe[probeKey] = (...args: unknown[]) => { calls.push(args) }
      expect(directFetcher("http://fixture.invalid", {})).toBe(responsePromise)
      expect(calls).toContainEqual(["mark", "http.dispatch", undefined])
      globalProbe[probeKey] = () => { throw new Error("probe failure") }
      expect(directFetcher("http://fixture.invalid", {})).toBe(responsePromise)
      delete globalProbe[probeKey]
      expect(directFetcher("http://fixture.invalid", {})).toBe(responsePromise)
      const sentinel = new Error("original synchronous failure")
      globalThis.fetch = Object.assign(() => { throw sentinel }, { preconnect: originalFetch.preconnect })
      expect(() => directFetcher("http://fixture.invalid", {})).toThrow(sentinel)
    } finally { globalThis.fetch = originalFetch }
  })
})
