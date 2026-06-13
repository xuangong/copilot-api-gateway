import { test, expect } from "bun:test"
import { __registerPlatformReset, __resetPlatformForTests } from "../src/reset.ts"

test("__resetPlatformForTests calls every registered callback", () => {
  let a = 0
  let b = 0
  __registerPlatformReset(() => { a++ })
  __registerPlatformReset(() => { b++ })
  __resetPlatformForTests()
  expect(a).toBe(1)
  expect(b).toBe(1)
})

test("callbacks are deduplicated by identity", () => {
  let n = 0
  const fn = () => { n++ }
  __registerPlatformReset(fn)
  __registerPlatformReset(fn)
  __resetPlatformForTests()
  expect(n).toBe(1)
})
