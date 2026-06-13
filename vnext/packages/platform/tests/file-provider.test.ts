import { test, expect, beforeEach } from "bun:test"
import {
  initFileProvider,
  getFileProvider,
  type FileProvider,
} from "../src/file-provider.ts"
import { __resetPlatformForTests } from "../src/reset.ts"

beforeEach(() => __resetPlatformForTests())

const stub: FileProvider = {
  put: async () => undefined,
  get: async () => null,
  delete: async () => undefined,
}

test("getFileProvider throws before init", () => {
  expect(() => getFileProvider()).toThrow(/FileProvider not initialized/)
})

test("init/get round-trip", () => {
  initFileProvider(stub)
  expect(getFileProvider()).toBe(stub)
})

test("reset clears", () => {
  initFileProvider(stub)
  __resetPlatformForTests()
  expect(() => getFileProvider()).toThrow()
})
