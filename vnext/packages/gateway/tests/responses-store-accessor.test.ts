import { test, expect, beforeEach } from "bun:test"
import {
  initResponsesStore,
  getResponsesStore,
} from "../src/shared/runtime/responses-store.ts"
import { __resetPlatformForTests } from "@vibe-core/platform"
import { InMemoryResponsesSnapshotStore } from "@vibe-llm/responses-store"

beforeEach(() => __resetPlatformForTests())

test("getResponsesStore throws before init", () => {
  expect(() => getResponsesStore()).toThrow(/ResponsesStore not initialized/)
})

test("init/get round-trip", () => {
  const s = new InMemoryResponsesSnapshotStore()
  initResponsesStore(s)
  expect(getResponsesStore()).toBe(s)
})

test("reset clears", () => {
  initResponsesStore(new InMemoryResponsesSnapshotStore())
  __resetPlatformForTests()
  expect(() => getResponsesStore()).toThrow()
})
