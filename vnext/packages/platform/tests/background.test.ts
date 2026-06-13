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
