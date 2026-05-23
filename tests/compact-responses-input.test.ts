import { test, expect } from "bun:test"

import {
  compactResponsesInputForChatFallback,
} from "../src/transforms/compact-responses-input"
import type { ResponseInputItem } from "../src/transforms/types"

const fco = (id: string, output: string): ResponseInputItem => ({
  type: "function_call_output",
  call_id: id,
  output,
})

test("no-op when input fits in budget", () => {
  const input: ResponseInputItem[] = [fco("a", "small")]
  const { items, stats } = compactResponsesInputForChatFallback(input, 10_000)
  expect(items).toBe(input)
  expect(stats.truncated).toBe(0)
})

test("truncates oldest oversized function_call_output first", () => {
  const big = "x".repeat(2_000_000)
  const input: ResponseInputItem[] = [
    fco("old", big),
    fco("mid", big),
    fco("new", "still here"),
  ]
  const { items, stats } = compactResponsesInputForChatFallback(input, 100_000)
  expect(stats.truncated).toBe(2)
  const oldOut = items[0] as { output: string }
  const midOut = items[1] as { output: string }
  const newOut = items[2] as { output: string }
  expect(oldOut.output).toContain("truncated by gateway")
  expect(midOut.output).toContain("truncated by gateway")
  expect(newOut.output).toBe("still here")
})

test("preserves last function_call_output even if oversized", () => {
  const big = "x".repeat(2_000_000)
  const input: ResponseInputItem[] = [fco("only", big)]
  const { items, stats } = compactResponsesInputForChatFallback(input, 100_000)
  expect(stats.truncated).toBe(0)
  expect((items[0] as { output: string }).output).toBe(big)
})

test("never touches message items", () => {
  const big = "x".repeat(2_000_000)
  const input: ResponseInputItem[] = [
    { type: "message", role: "user", content: big },
    fco("a", big),
    fco("last", "active"),
  ]
  const { items } = compactResponsesInputForChatFallback(input, 100_000)
  expect((items[0] as { content: string }).content).toBe(big)
})
