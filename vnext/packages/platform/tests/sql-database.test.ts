import { test, expect, beforeEach } from "bun:test"
import {
  initSqlDatabase,
  getSqlDatabase,
  type SqlDatabase,
} from "../src/sql-database.ts"
import { __resetPlatformForTests } from "../src/reset.ts"

beforeEach(() => __resetPlatformForTests())

const stubDb: SqlDatabase = {
  prepare: () => { throw new Error("stub") },
  exec: async () => undefined,
}

test("getSqlDatabase throws before init", () => {
  expect(() => getSqlDatabase()).toThrow(/SqlDatabase not initialized/)
})

test("getSqlDatabase returns the impl after init", () => {
  initSqlDatabase(stubDb)
  expect(getSqlDatabase()).toBe(stubDb)
})

test("__resetPlatformForTests clears the slot", () => {
  initSqlDatabase(stubDb)
  __resetPlatformForTests()
  expect(() => getSqlDatabase()).toThrow(/SqlDatabase not initialized/)
})
