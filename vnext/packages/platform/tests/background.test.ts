import { test, expect, beforeEach } from "bun:test"
import {
  initBackground,
  waitUntil,
  type BackgroundExecutor,
} from "../src/background.ts"
import { __resetPlatformForTests } from "../src/reset.ts"

beforeEach(() => __resetPlatformForTests())

test("waitUntil throws before init", () => {
  expect(() => waitUntil(Promise.resolve())).toThrow(/Background not initialized/)
})

test("waitUntil delegates to injected executor", () => {
  const seen: Promise<unknown>[] = []
  const exec: BackgroundExecutor = { waitUntil: (p) => { seen.push(p) } }
  initBackground(exec)
  const p = Promise.resolve(42)
  waitUntil(p)
  expect(seen).toEqual([p])
})

test("capturing an absent executor preserves its bootstrap error after later initialization", async () => {
  const { captureBackgroundExecutor, withBackground } = await import("../src/background.ts")
  expect(typeof captureBackgroundExecutor).toBe("function")
  const captured = captureBackgroundExecutor()
  const later = { pending: [] as Promise<unknown>[], waitUntil(work: Promise<unknown>) { this.pending.push(work) } }
  initBackground(later)
  const work = Promise.resolve()
  expect(() => captured.waitUntil(work)).toThrow(/Background not initialized/)
  withBackground(later, () => {
    expect(() => captured.waitUntil(work)).toThrow(/Background not initialized/)
  })
  expect(later.pending).toEqual([])
})

test("captured global and scoped executors retain their receiver outside their originating scope", async () => {
  const { captureBackgroundExecutor, withBackground } = await import("../src/background.ts")
  expect(typeof captureBackgroundExecutor).toBe("function")
  const global = { pending: [] as Promise<unknown>[], waitUntil(work: Promise<unknown>) { this.pending.push(work) } }
  const scoped = { pending: [] as Promise<unknown>[], waitUntil(work: Promise<unknown>) { this.pending.push(work) } }
  const consumer = { pending: [] as Promise<unknown>[], waitUntil(work: Promise<unknown>) { this.pending.push(work) } }
  initBackground(global)
  const globalCapture = captureBackgroundExecutor()
  const scopedCapture = withBackground(scoped, captureBackgroundExecutor)
  const a = Promise.resolve('global'), b = Promise.resolve('scoped')
  initBackground(consumer)
  withBackground(consumer, () => {
    globalCapture.waitUntil(a)
    scopedCapture.waitUntil(b)
  })
  expect(global.pending).toEqual([a])
  expect(scoped.pending).toEqual([b])
  expect(consumer.pending).toEqual([])
})

test("interleaved requests retain their own background executor across awaits", async () => {
  const { withBackground } = await import("../src/background.ts")
  const first: Promise<unknown>[] = []
  const second: Promise<unknown>[] = []
  const fallback: Promise<unknown>[] = []
  initBackground({ waitUntil: p => { fallback.push(p) } })
  let release: () => void = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  const a = Promise.resolve("a")
  const b = Promise.resolve("b")
  const requestA = withBackground({ waitUntil: p => { first.push(p) } }, async () => {
    await gate
    waitUntil(a)
  })
  await withBackground({ waitUntil: p => { second.push(p) } }, async () => {
    await Promise.resolve()
    waitUntil(b)
    release()
  })
  await requestA
  expect(first).toEqual([a])
  expect(second).toEqual([b])
  expect(fallback).toEqual([])
})
