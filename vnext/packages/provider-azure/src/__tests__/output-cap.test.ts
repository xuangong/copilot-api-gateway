/**
 * Azure reasoning models accept the Chat Completions output cap only as
 * `max_completion_tokens` and reject `max_tokens`:
 * https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/reasoning
 * Translators emit `max_tokens`, which generic OpenAI-compatible servers
 * (DeepSeek, Ollama) need, so the Azure boundary renames it for reasoning
 * models only — the same split LiteLLM makes
 * (litellm/llms/azure/chat/gpt_transformation.py, requires_max_completion_tokens).
 */
import { expect, test } from "bun:test"
import type { Fetcher } from "@vibe-core/upstream"
import { AzureProvider } from "../provider.ts"

const CONFIG = {
  name: "azure-test",
  endpoint: "https://example.openai.azure.com",
  apiKey: "fixture",
  deployment: "gpt-4o-deploy",
  deployments: [{ name: "o3-deploy", model: "o3-mini" }, { name: "gpt5-deploy", model: "gpt-5" }],
  apiVersion: "2024-10-21",
  endpoints: ["chat_completions"] as const,
}

async function sentBody(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  let body = ""
  const fetcher: Fetcher = async (_url, init) => { body = String(init?.body); return Response.json({ id: "x" }) }
  await new AzureProvider(CONFIG, fetcher).fetch({ endpoint: "chat_completions", sourceApi: "openai", headers: new Headers(), payload })
  return JSON.parse(body) as Record<string, unknown>
}

test.each(["o3-mini", "gpt-5"])("a %s request's max_tokens becomes max_completion_tokens", async model => {
  const body = await sentBody({ model, messages: [], max_tokens: 2048 })
  expect([body.max_tokens, body.max_completion_tokens]).toEqual([undefined, 2048])
})

test("a non-reasoning deployment keeps max_tokens", async () => {
  const body = await sentBody({ model: "gpt-4o", messages: [], max_tokens: 2048 })
  expect([body.max_tokens, body.max_completion_tokens]).toEqual([2048, undefined])
})

test("a caller that already sent max_completion_tokens is left alone", async () => {
  const body = await sentBody({ model: "o3-mini", messages: [], max_completion_tokens: 100 })
  expect([body.max_tokens, body.max_completion_tokens]).toEqual([undefined, 100])
})
