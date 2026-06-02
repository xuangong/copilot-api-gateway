import { test, expect } from "bun:test"
import { ALL_ENDPOINT_KEYS, type EndpointKey } from "~/protocols/common"

test("ALL_ENDPOINT_KEYS lists all 7 endpoints", () => {
  expect([...ALL_ENDPOINT_KEYS].sort()).toEqual([
    "chat_completions",
    "embeddings",
    "images_edits",
    "images_generations",
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

test("EndpointKey includes images_generations and images_edits", () => {
  const keys: EndpointKey[] = [
    "chat_completions", "responses", "messages",
    "messages_count_tokens", "embeddings",
    "images_generations", "images_edits",
  ]
  for (const k of keys) {
    expect(ALL_ENDPOINT_KEYS).toContain(k)
  }
  expect(ALL_ENDPOINT_KEYS.length).toBe(7)
})
