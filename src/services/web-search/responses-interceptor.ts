import type { AccountType } from "~/config/constants"
import {
  translateResponsesToChatCompletions,
  translateChatCompletionsToResponses,
  type ChatCompletionResponse,
  type ResponsesAPIResponse,
} from "~/services/responses"
import type { ResponsesPayload, ResponseTool } from "~/transforms/types"

import type { EngineManagerOptions } from "./engine-manager"
import {
  interceptOpenAIChat,
  type OpenAIChatPayload,
  type OpenAIChatResponse,
} from "./openai-interceptor"
import type { WebSearchMeta } from "./types"

const RESPONSES_WEB_SEARCH_TYPES = new Set(["web_search", "web_search_preview"])

/**
 * Detect web_search-style hosted tools in a Responses API payload.
 * Both `web_search` and `web_search_preview` are routed through the
 * gateway's intercept loop on the chat-fallback path.
 */
export function hasResponsesWebSearch(payload: ResponsesPayload): boolean {
  const tools = payload.tools
  if (!Array.isArray(tools)) return false
  return tools.some(
    (t) => typeof t?.type === "string" && RESPONSES_WEB_SEARCH_TYPES.has(t.type),
  )
}

/**
 * Strip every web_search variant from a Responses tool list. Used before
 * translating to Chat (so the standard web_search function tool the
 * intercept loop injects is the only one upstream sees).
 */
function stripResponsesWebSearchTools(tools?: ResponseTool[] | null): ResponseTool[] | undefined {
  if (!Array.isArray(tools)) return undefined
  const filtered = tools.filter(
    (t) => !(typeof t?.type === "string" && RESPONSES_WEB_SEARCH_TYPES.has(t.type)),
  )
  return filtered.length > 0 ? filtered : undefined
}

export interface InterceptResponsesOptions {
  copilotToken: string
  accountType: AccountType
  engineOptions: EngineManagerOptions
}

export interface InterceptResponsesResult {
  responsesResult: ResponsesAPIResponse
  chatResponse: OpenAIChatResponse
  meta: WebSearchMeta
}

/**
 * Run the chat-fallback Responses intercept loop:
 *   Responses payload → Chat payload → multi-turn web_search loop →
 *   Chat response → Responses response.
 *
 * Only used for non-gpt-5.x models (the path that already converts via
 * /chat/completions). gpt-5.x direct passthrough is handled separately
 * by the route (currently strip + warn).
 */
export async function interceptResponsesViaChat(
  payload: ResponsesPayload,
  options: InterceptResponsesOptions,
): Promise<InterceptResponsesResult> {
  const model = payload.model
  // Drop web_search tools before translation — convertTools already filters
  // them, but being explicit avoids depending on that internal behaviour.
  const cleanedPayload: ResponsesPayload = {
    ...payload,
    tools: stripResponsesWebSearchTools(payload.tools),
  }

  const chatPayload = translateResponsesToChatCompletions(cleanedPayload, model)
  // Force non-stream upstream — the loop always runs synchronous turns.
  const interceptPayload: OpenAIChatPayload = {
    ...(chatPayload as unknown as OpenAIChatPayload),
    stream: false,
  }

  const { response: chatResponse, meta } = await interceptOpenAIChat(
    interceptPayload,
    {
      copilotToken: options.copilotToken,
      accountType: options.accountType,
      engineOptions: options.engineOptions,
    },
  )

  const responsesResult = translateChatCompletionsToResponses(
    chatResponse as unknown as ChatCompletionResponse,
    model,
    payload,
  )

  return { responsesResult, chatResponse, meta }
}
