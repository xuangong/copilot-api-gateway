import { expect, test } from "bun:test"
import { runInterceptors } from "@vibe-core/service"
import type { ProtocolFrame } from "@vibe-core/result"
import {
  llmEventResult,
  type Invocation,
  type LlmExecuteResult,
  type RequestContext,
  type TelemetryModelIdentity,
} from "@vibe-llm/protocols/common"
import { chatCompletionsInterceptors } from "../../../../src/data-plane/chat-flow/chat-completions/interceptors"
import { geminiInterceptors } from "../../../../src/data-plane/chat-flow/gemini/interceptors"
import { messagesInterceptors } from "../../../../src/data-plane/chat-flow/messages/interceptors"
import { responsesInterceptors } from "../../../../src/data-plane/chat-flow/responses/interceptors"
import type { LlmInterceptor } from "../../../../src/data-plane/chat-flow/shared/interceptor-types"
import { withRequestNormalization } from "../../../../src/data-plane/chat-flow/shared/request-normalization"

const identity: TelemetryModelIdentity = {
  incomingModel: "model", model: "model", modelKey: "model", upstream: "test", cost: null,
}
const context: RequestContext = { requestStartedAt: 0 }
const emptyFrames = async function* <T>(): AsyncGenerator<ProtocolFrame<T>> { yield* [] }

const invocation = (
  endpoint: Invocation["endpoint"],
  payload: Record<string, unknown>,
  flags: readonly string[],
): Invocation => ({ endpoint, payload, enabledFlags: new Set(flags), headers: {} })

const recordRegistry = async <T>(
  inv: Invocation,
  registry: readonly LlmInterceptor<LlmExecuteResult<ProtocolFrame<T>>>[],
) => {
  let terminalPayload: Record<string, unknown> | undefined
  const result = await runInterceptors(inv, context, registry, async () => {
    terminalPayload = inv.payload
    return llmEventResult(emptyFrames<T>(), identity)
  })
  expect(result.type).toBe("events")
  expect(terminalPayload).toBe(inv.payload)
  return terminalPayload
}

test("Responses registry translates forced-choice reasoning to Qwen after canonical normalization", async () => {
  const payload = {
    model: "model", input: [], tool_choice: "required", reasoning: { effort: "high", summary: "auto" },
  }
  const inv = invocation("responses", payload, ["disable-reasoning-on-forced-tool-choice", "vendor-qwen"])
  const outbound = await recordRegistry(inv, responsesInterceptors)
  expect(outbound).toEqual({ model: "model", input: [], tool_choice: "required", enable_thinking: false })
  expect(outbound).not.toBe(payload)
})

test("Chat registry translates forced-choice reasoning to Qwen after canonical normalization", async () => {
  const payload = {
    model: "model", messages: [], tool_choice: "required", reasoning_effort: "high",
  }
  const inv = invocation("chat_completions", payload, ["disable-reasoning-on-forced-tool-choice", "vendor-qwen"])
  const outbound = await recordRegistry(inv, chatCompletionsInterceptors)
  expect(outbound).toEqual({ model: "model", messages: [], tool_choice: "required", enable_thinking: false })
  expect(outbound).not.toBe(payload)
})

test("Responses registry neutralizes empty-tools forced choice before disabling reasoning", async () => {
  const reasoning = { effort: "high", summary: "auto" }
  const inv = invocation("responses", {
    model: "model", input: [], tools: [], tool_choice: "required", reasoning,
  }, ["empty-tools-tool-choice-none", "disable-reasoning-on-forced-tool-choice", "vendor-qwen"])
  expect(await recordRegistry(inv, responsesInterceptors)).toEqual({
    model: "model", input: [], tools: [], tool_choice: "none", reasoning,
  })
  expect(inv.payload.reasoning).toBe(reasoning)
})

test("Chat registry neutralizes empty-tools forced choice before disabling reasoning", async () => {
  const inv = invocation("chat_completions", {
    model: "model", messages: [], tools: [], tool_choice: "required", reasoning_effort: "high",
  }, ["empty-tools-tool-choice-none", "disable-reasoning-on-forced-tool-choice", "vendor-qwen"])
  expect(await recordRegistry(inv, chatCompletionsInterceptors)).toEqual({
    model: "model", messages: [], tools: [], tool_choice: "none", reasoning_effort: "high",
  })
})

test("Messages registry neutralizes empty-tools forced choice and preserves thinking and output effort", async () => {
  const thinking = { type: "enabled", budget_tokens: 1024, display: "full" }
  const output_config = { effort: "high", format: { type: "json_schema", schema: { type: "object" } } }
  const inv = invocation("messages", {
    model: "model", messages: [], tools: [], tool_choice: { type: "any" }, thinking, output_config,
  }, ["empty-tools-tool-choice-none", "disable-reasoning-on-forced-tool-choice"])
  expect(await recordRegistry(inv, messagesInterceptors)).toEqual({
    model: "model", messages: [], tools: [], tool_choice: { type: "none" }, thinking, output_config,
  })
  expect(inv.payload.thinking).toBe(thinking)
  expect(inv.payload.output_config).toBe(output_config)
})

const assertReentry = async <T>(
  endpoint: Invocation["endpoint"],
  registry: readonly LlmInterceptor<LlmExecuteResult<ProtocolFrame<T>>>[],
  turns: readonly Record<string, unknown>[],
  expected: readonly Record<string, unknown>[],
) => {
  const inv = invocation(endpoint, {}, [
    "strip-prompt-cache-key", "promote-system-to-developer", "disable-reasoning-on-forced-tool-choice", "vendor-qwen",
  ])
  const seen: Record<string, unknown>[] = []
  const replacements: Record<string, unknown>[] = []
  // This fixture exercises downstream reentry; hosted-tool orchestration itself
  // is covered by the existing server-tool and image-injection suites.
  const outer: LlmInterceptor<LlmExecuteResult<ProtocolFrame<T>>> = async (request, _ctx, next) => {
    expect(request).toBe(inv)
    let last: LlmExecuteResult<ProtocolFrame<T>> | undefined
    for (const turn of turns) {
      request.payload = turn
      last = await next()
      replacements.push(request.payload)
    }
    if (!last) throw new Error("expected at least one turn")
    return last
  }
  await runInterceptors(inv, context, [outer, ...registry], async () => {
    seen.push(inv.payload)
    return llmEventResult(emptyFrames<T>(), identity)
  })
  expect(seen).toEqual(expected)
  expect(replacements).toEqual(expected)
  for (const [index, payload] of seen.entries()) {
    expect(payload).toBe(replacements[index])
    expect(payload).not.toBe(turns[index])
  }
  expect(inv.payload).toBe(seen.at(-1))
}

test("Responses registry reentry reads and replaces each turn's latest invocation payload", async () => {
  await assertReentry("responses", responsesInterceptors, [
    {
      model: "first", input: [{ type: "message", role: "system", content: "one" }],
      prompt_cache_key: "first-cache", tool_choice: "required", reasoning: { effort: "high" },
    },
    {
      model: "second", input: [{ type: "message", role: "system", content: "two" }],
      prompt_cache_key: "second-cache", tool_choice: { type: "function", name: "lookup" }, reasoning: { effort: "medium" },
    },
  ], [
    {
      model: "first", input: [{ type: "message", role: "developer", content: "one" }],
      tool_choice: "required", enable_thinking: false,
    },
    {
      model: "second", input: [{ type: "message", role: "developer", content: "two" }],
      tool_choice: { type: "function", name: "lookup" }, enable_thinking: false,
    },
  ])
})

test("Chat registry reentry reads and replaces each turn's latest invocation payload", async () => {
  await assertReentry("chat_completions", chatCompletionsInterceptors, [
    {
      model: "first", messages: [{ role: "system", content: "one" }],
      prompt_cache_key: "first-cache", tool_choice: "required", reasoning_effort: "high",
    },
    {
      model: "second", messages: [{ role: "system", content: "two" }],
      prompt_cache_key: "second-cache", tool_choice: { type: "function", name: "lookup" }, reasoning_effort: "medium",
    },
  ], [
    {
      model: "first", messages: [{ role: "developer", content: "one" }],
      tool_choice: "required", enable_thinking: false,
    },
    {
      model: "second", messages: [{ role: "developer", content: "two" }],
      tool_choice: { type: "function", name: "lookup" }, enable_thinking: false,
    },
  ])
})

test("Gemini registry cleans parts and tools while preserving hosted-search declarations", async () => {
  const inv = invocation("gemini", {
    contents: [{ parts: [{ text: "keep", fileData: {} }, { executableCode: {} }] }],
    systemInstruction: { parts: [{ text: "system", codeExecutionResult: {} }] },
    tools: [{ googleSearch: {}, codeExecution: {} }, { googleSearchRetrieval: {} }, { computerUse: {} }],
    safetySettings: [{ category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }],
  }, [])
  expect(await recordRegistry(inv, geminiInterceptors)).toEqual({
    contents: [{ parts: [{ text: "keep" }] }],
    systemInstruction: { parts: [{ text: "system" }] },
    tools: [{ googleSearch: {} }, { googleSearchRetrieval: {} }],
  })
})

const replacePayload = withRequestNormalization<Invocation["payload"]>((request) => {
  request.payload = { ...request.payload, normalized: true }
})

test("gateway normalization adapter exposes the original invocation and replacement to the terminal", async () => {
  const original = { model: "model" }
  const inv = invocation("responses", original, [])
  const result = await runInterceptors(inv, context, [replacePayload], async () => inv.payload)
  expect(result).toBe(inv.payload)
  expect(result).not.toBe(original)
  expect(result).toEqual({ model: "model", normalized: true })
})
