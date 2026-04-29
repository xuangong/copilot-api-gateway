import type { AccountType } from "~/config/constants"
import { callCopilotAPI } from "~/services/copilot"

import {
  MAX_USES_HARD_LIMIT,
  emptyMeta,
  executeWebSearch,
} from "./core"
import { EngineManager, type EngineManagerOptions } from "./engine-manager"
import type { WebSearchMeta } from "./types"

// ── Minimal OpenAI Chat Completions wire types ─────────────────────────

export interface OpenAIFunctionTool {
  type: "function"
  function: {
    name: string
    description?: string
    parameters?: Record<string, unknown>
  }
}

export interface OpenAIHostedTool {
  type: string // e.g. "web_search_preview", "web_search"
  [key: string]: unknown
}

export type OpenAITool = OpenAIFunctionTool | OpenAIHostedTool

export interface OpenAIToolCall {
  id: string
  type: "function"
  function: {
    name: string
    arguments: string
  }
}

export interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool"
  content?: string | unknown[] | null
  tool_calls?: OpenAIToolCall[]
  tool_call_id?: string
  name?: string
}

export interface OpenAIChatPayload {
  model: string
  messages: OpenAIMessage[]
  tools?: OpenAITool[]
  tool_choice?: unknown
  stream?: boolean
  stream_options?: Record<string, unknown>
  [key: string]: unknown
}

export interface OpenAIChoice {
  index?: number
  message: OpenAIMessage
  finish_reason?: string | null
}

export interface OpenAIChatResponse {
  id: string
  object?: string
  created?: number
  model: string
  choices: OpenAIChoice[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
}

// ── Detection / preparation ────────────────────────────────────────────

const WEB_SEARCH_HOSTED_TYPES = new Set(["web_search", "web_search_preview"])

function isFunctionWebSearch(t: OpenAITool): t is OpenAIFunctionTool {
  return (
    t.type === "function" &&
    typeof (t as OpenAIFunctionTool).function?.name === "string" &&
    (t as OpenAIFunctionTool).function.name === "web_search"
  )
}

function isHostedWebSearch(t: OpenAITool): boolean {
  return typeof t.type === "string" && WEB_SEARCH_HOSTED_TYPES.has(t.type)
}

export function hasOpenAIWebSearch(payload: OpenAIChatPayload): boolean {
  if (!Array.isArray(payload.tools)) return false
  return payload.tools.some((t) => isFunctionWebSearch(t) || isHostedWebSearch(t))
}

const STANDARD_WEB_SEARCH_TOOL: OpenAIFunctionTool = {
  type: "function",
  function: {
    name: "web_search",
    description:
      "Search the web for current information. Use this when you need to find recent information, news, or answers to questions that require up-to-date knowledge.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The search query to execute",
        },
      },
      required: ["query"],
    },
  },
}

/**
 * Strip every web_search variant the client sent and re-attach a single
 * normalised function tool the upstream can actually invoke.
 */
export function prepareOpenAIPayload(
  payload: OpenAIChatPayload,
): OpenAIChatPayload {
  const tools = Array.isArray(payload.tools) ? payload.tools : []
  const otherTools = tools.filter(
    (t) => !isFunctionWebSearch(t) && !isHostedWebSearch(t),
  )
  return {
    ...payload,
    tools: [...otherTools, STANDARD_WEB_SEARCH_TOOL],
  }
}

// ── Loop ───────────────────────────────────────────────────────────────

export interface InterceptOpenAIOptions {
  copilotToken: string
  accountType: AccountType
  engineOptions: EngineManagerOptions
  /** Endpoint override (default `/chat/completions`). */
  endpoint?: string
  /** Optional pass-through headers (e.g. anthropic-beta — usually unused for OpenAI). */
  extraHeaders?: Record<string, string>
}

interface ClassifiedToolCalls {
  webSearchCalls: OpenAIToolCall[]
  hasOtherCalls: boolean
}

function classifyToolCalls(
  toolCalls: OpenAIToolCall[] | undefined,
): ClassifiedToolCalls {
  const all = Array.isArray(toolCalls) ? toolCalls : []
  const webSearchCalls = all.filter(
    (c) => c.type === "function" && c.function?.name === "web_search",
  )
  return { webSearchCalls, hasOtherCalls: all.length > webSearchCalls.length }
}

function parseQuery(args: string): string {
  if (!args) return ""
  try {
    const parsed = JSON.parse(args) as { query?: string }
    return typeof parsed.query === "string" ? parsed.query : ""
  } catch {
    return ""
  }
}

async function callChat(
  payload: OpenAIChatPayload,
  options: InterceptOpenAIOptions,
): Promise<OpenAIChatResponse> {
  const response = await callCopilotAPI({
    endpoint: options.endpoint ?? "/chat/completions",
    payload: { ...payload, stream: false } as unknown as Record<string, unknown>,
    operationName: "chat completions (web_search intercept)",
    copilotToken: options.copilotToken,
    accountType: options.accountType,
    extraHeaders: options.extraHeaders,
  })
  return (await response.json()) as OpenAIChatResponse
}

/**
 * Run the multi-turn web_search loop against /chat/completions.
 * Always non-stream upstream — caller replays as SSE if the client wanted streaming.
 */
export async function interceptOpenAIChat(
  payload: OpenAIChatPayload,
  options: InterceptOpenAIOptions,
): Promise<{ response: OpenAIChatResponse; meta: WebSearchMeta }> {
  const meta = emptyMeta()
  const engineManager = new EngineManager(options.engineOptions)
  const prepared = prepareOpenAIPayload(payload)

  const messages: OpenAIMessage[] = [...(prepared.messages ?? [])]
  let searchCount = 0

  // Defensive: bound iteration count separately from search count.
  for (let turn = 0; turn <= MAX_USES_HARD_LIMIT; turn++) {
    const turnPayload: OpenAIChatPayload = { ...prepared, messages }
    const response = await callChat(turnPayload, options)

    const assistantMessage = response.choices?.[0]?.message
    const { webSearchCalls, hasOtherCalls } = classifyToolCalls(
      assistantMessage?.tool_calls,
    )

    if (webSearchCalls.length === 0 || hasOtherCalls) {
      // Either no web_search to run, or the model also asked for other tools —
      // hand control back to the caller in either case.
      return { response, meta }
    }

    if (searchCount >= MAX_USES_HARD_LIMIT) {
      // Hit the hard cap — return whatever upstream gave us this turn.
      return { response, meta }
    }

    // Replay the assistant message verbatim (preserves tool_calls structure
    // expected by the next /chat/completions turn).
    messages.push({
      role: "assistant",
      content: assistantMessage?.content ?? null,
      tool_calls: assistantMessage?.tool_calls,
    })

    for (const call of webSearchCalls) {
      if (searchCount >= MAX_USES_HARD_LIMIT) {
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: `Error: Maximum web search uses (${MAX_USES_HARD_LIMIT}) exceeded`,
        })
        continue
      }
      searchCount++
      meta.searchCount = searchCount
      const query = parseQuery(call.function?.arguments ?? "")
      const { content } = await executeWebSearch(query, null, engineManager, meta)
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content,
      })
    }
  }

  // Should be unreachable — loop above always returns once it stops finding
  // web_search calls. Defensive final upstream call so we never return undefined.
  const finalResponse = await callChat({ ...prepared, messages }, options)
  return { response: finalResponse, meta }
}
