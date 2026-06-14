import { test, expect, beforeEach } from "bun:test"
import { initRepo, getRepo } from "../../src/shared/repo/index.ts"
import { __resetPlatformForTests } from "@vnext/platform"
import { SqliteRepo } from "../../src/shared/repo/sqlite.ts"
import { Database } from "bun:sqlite"

beforeEach(() => __resetPlatformForTests())

test("getRepo throws before init", () => {
  expect(() => getRepo()).toThrow(/Repo not initialized/)
})

test("init/get round-trip", () => {
  const repo = new SqliteRepo(new Database(":memory:"))
  initRepo(repo)
  expect(getRepo()).toBe(repo)
})

test("__resetPlatformForTests clears the slot", () => {
  initRepo(new SqliteRepo(new Database(":memory:")))
  __resetPlatformForTests()
  expect(() => getRepo()).toThrow(/Repo not initialized/)
})
