import { expect, test } from "bun:test"
import type { CodexQuotaResponse } from "../../api/upstreams"
import { CodexQuotaReader, type QuotaReadState } from "./codex-quota-read"

function deferred() {
  let resolve: (value: CodexQuotaResponse) => void = () => { throw new Error("not initialized") }
  let reject: (reason: Error) => void = () => { throw new Error("not initialized") }
  const promise = new Promise<CodexQuotaResponse>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

test("changed account and reload invalidate late success even if fetch ignores cancellation", async () => {
  const reader = new CodexQuotaReader()
  const old = deferred()
  const next = deferred()
  const states: QuotaReadState[] = []
  let oldSignal: AbortSignal | undefined
  const first = reader.read("a", (_id, signal) => { oldSignal = signal; return old.promise }, value => states.push(value))
  const second = reader.read("b", () => next.promise, value => states.push(value))
  expect(oldSignal?.aborted).toBe(true)
  next.resolve({ quota: null })
  await second
  old.resolve({ quota: {} })
  await first
  expect(states).toEqual([{ status: "loading" }, { status: "loading" }, { status: "ready", result: { quota: null } }])
})

test("unmount cancels and suppresses late rejection; active failures can retry", async () => {
  const reader = new CodexQuotaReader()
  const pending = deferred()
  const states: QuotaReadState[] = []
  const call = reader.read("a", () => pending.promise, value => states.push(value))
  reader.cancel()
  pending.reject(new Error("SECRET"))
  await call
  expect(states).toEqual([{ status: "loading" }])
  await reader.read("a", async () => { throw new Error("SECRET") }, value => states.push(value))
  expect(states.at(-1)).toEqual({ status: "error" })
  await reader.read("a", async () => ({ quota: null }), value => states.push(value))
  expect(states.at(-1)).toEqual({ status: "ready", result: { quota: null } })
  expect(JSON.stringify(states)).not.toContain("SECRET")
})
