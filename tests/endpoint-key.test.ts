import { test, expect } from "bun:test"
import { ALL_ENDPOINT_KEYS, type EndpointKey } from "~/protocols/common"

test("ALL_ENDPOINT_KEYS lists the 5 current endpoints", () => {
  expect([...ALL_ENDPOINT_KEYS].sort()).toEqual([
    "chat_completions",
    "embeddings",
    "messages",
    "messages_count_tokens",
    "responses",
  ])
})

test("EndpointKey type is assignable from each literal", () => {
  const keys: EndpointKey[] = [
    "chat_completions",
    "responses",
    "messages",
    "messages_count_tokens",
    "embeddings",
  ]
  expect(keys.length).toBe(5)
})
