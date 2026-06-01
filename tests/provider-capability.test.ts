import { test, expect } from "bun:test"
import type { ModelProvider } from "~/providers/types"
import type { EndpointKey } from "~/protocols/common"

test("ModelProvider interface declares supportedEndpoints and fetch()", () => {
  // Compile-time only: a value satisfying the interface must have both.
  const stub: Pick<ModelProvider, "supportedEndpoints" | "fetch"> = {
    supportedEndpoints: ["chat_completions"] as readonly EndpointKey[],
    fetch: async () => new Response("ok"),
  }
  expect(stub.supportedEndpoints).toContain("chat_completions")
})

import { CopilotProvider } from "~/providers/copilot/provider"

test("CopilotProvider declares its supportedEndpoints", () => {
  const p = new CopilotProvider({ copilotToken: "tok", accountType: "individual" })
  expect([...p.supportedEndpoints].sort()).toEqual([
    "chat_completions",
    "embeddings",
    "messages",
    "messages_count_tokens",
    "responses",
  ])
})

test("CopilotProvider.fetch is a function with correct shape", () => {
  const p = new CopilotProvider({ copilotToken: "tok", accountType: "individual" })
  expect(typeof p.fetch).toBe("function")
})

import { CustomProvider } from "~/providers/custom/provider"

test("CustomProvider defaults supportedEndpoints to chat_completions + embeddings", () => {
  const p = new CustomProvider({
    name: "stub",
    baseUrl: "https://example.test",
    apiKey: "k",
  })
  expect([...p.supportedEndpoints].sort()).toEqual(["chat_completions", "embeddings"])
})

test("CustomProvider honors explicit endpoints config", () => {
  const p = new CustomProvider({
    name: "stub",
    baseUrl: "https://example.test",
    apiKey: "k",
    endpoints: ["chat_completions", "responses", "messages"],
  })
  expect([...p.supportedEndpoints].sort()).toEqual(["chat_completions", "messages", "responses"])
})

import { AzureProvider } from "~/providers/azure/provider"

test("AzureProvider mirrors its endpoints config to supportedEndpoints", () => {
  const p = new AzureProvider({
    name: "az",
    endpoint: "https://r.openai.azure.com",
    apiKey: "k",
    deployment: "gpt-4o",
    apiVersion: "2024-02-15-preview",
    endpoints: ["chat_completions", "embeddings"],
  })
  expect([...p.supportedEndpoints].sort()).toEqual(["chat_completions", "embeddings"])
})
