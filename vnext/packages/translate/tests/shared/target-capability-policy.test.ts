/**
 * Hosted Responses tools (web_search, file_search, …) sent to a Chat or
 * Messages target that cannot run them. Decided 2026-11-19 against reference
 * copilot-gateway #619, which rejects them outright:
 *
 * - Offered only: dropped. Offering a tool is optional capability, and Codex
 *   attaches `web_search` to most requests; rejecting would 400 ordinary Codex
 *   traffic on any key without a configured search provider.
 * - Forced (tool_choice names it, or required allowed_tools selects only it):
 *   rejected, because the caller's demand cannot be met.
 *
 * When the gateway's server-tool shim is active it rewrites web_search into a
 * function tool before translation, so this policy only applies when it is not.
 */
import { expect, test } from "bun:test"
import type { ResponsesPayload } from "@vibe-llm/protocols/responses"
import { translateResponsesToMessages } from "../../src/responses-via-messages/request"
import { translateResponsesToChat } from "../../src/responses-via-chat-completions/request"

const fn = { type: "function", name: "f", parameters: { type: "object" } }
const TARGETS = [["messages", translateResponsesToMessages], ["chat", translateResponsesToChat]] as const
const names = (tools: unknown) => ((tools ?? []) as Array<{ name?: string; function?: { name: string } }>).map(tool => tool.name ?? tool.function?.name)

for (const [target, translate] of TARGETS) {
  const run = (fields: Record<string, unknown>) => translate({ model: "m", input: "hi", ...fields } as ResponsesPayload).target

  test.each([{ type: "web_search" }, { type: "file_search", vector_store_ids: ["vs"] }])(`${target}: an offered %o is dropped`, hosted => {
    expect(names(run({ tools: [hosted, fn] }).tools)).toEqual(["f"])
  })

  test.each([
    { type: "web_search" },
    "web_search",
    { type: "allowed_tools", mode: "required", tools: [{ type: "web_search" }] },
  ])(`${target}: forcing it with tool_choice %o is rejected`, choice => {
    expect(() => run({ tools: [{ type: "web_search" }, fn], tool_choice: choice })).toThrow()
  })
}

/**
 * Output cap on Chat Completions targets. Decided 2026-11-19 against reference
 * copilot-gateway #724 (which sends only `max_completion_tokens`): many
 * OpenAI-compatible servers know only `max_tokens` — DeepSeek, the production
 * custom upstream, documents nothing else and would silently fall back to its
 * 8K default. Surveyed gateways agree (LiteLLM openai_like, Vercel
 * openai-compatible, Portkey): one canonical cap, spelled per provider at its
 * boundary. Copilot routes gpt-5/o-series to Responses (provider-copilot
 * endpoints.ts); Azure renames for reasoning models (provider-azure provider.ts).
 */
test("a translated Chat request states its output cap as max_tokens only", () => {
  const target = translateResponsesToChat({ model: "m", input: "hi", max_output_tokens: 32768 } as ResponsesPayload).target as Record<string, unknown>
  expect([target.max_tokens, target.max_completion_tokens]).toEqual([32768, undefined])
})
