import { test, expect, beforeEach } from "bun:test"
import { initEnv, env } from "../src/env.ts"
import { __resetPlatformForTests } from "../src/reset.ts"

beforeEach(() => __resetPlatformForTests())

test("env throws before init", () => {
  expect(() => env("FOO")).toThrow(/env not initialized/)
})

test("env reads from injected lookup", () => {
  initEnv((name) => (name === "FOO" ? "bar" : ""))
  expect(env("FOO")).toBe("bar")
  expect(env("MISSING")).toBe("")
})
