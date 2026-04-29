import type { AccountType } from "~/config/constants"
import {
  translateGeminiToOpenAI,
  translateOpenAIToGemini,
  type ChatCompletionResponse,
} from "~/services/gemini/format-conversion"
import type { GeminiGenerateContentRequest } from "~/services/gemini/types"

import type { EngineManagerOptions } from "./engine-manager"
import {
  interceptOpenAIChat,
  type OpenAIChatPayload,
  type OpenAIChatResponse,
} from "./openai-interceptor"
import type { WebSearchMeta } from "./types"

// Gemini tools are typed with `functionDeclarations` only, but in practice
// clients also send hosted tool objects like `{ googleSearch: {} }` or
// `{ googleSearchRetrieval: {} }`. We treat any object key whose name we
// recognise as a hosted-search marker as web_search.
interface GeminiToolLike {
  functionDeclarations?: Array<{ name: string; description?: string; parameters?: Record<string, unknown> }>
  googleSearch?: unknown
  googleSearchRetrieval?: unknown
  google_search?: unknown
}

const HOSTED_SEARCH_KEYS = ["googleSearch", "googleSearchRetrieval", "google_search"] as const

function hasHostedSearch(t: GeminiToolLike): boolean {
  return HOSTED_SEARCH_KEYS.some((k) => t[k] !== undefined && t[k] !== null)
}

function hasFunctionWebSearch(t: GeminiToolLike): boolean {
  return Array.isArray(t.functionDeclarations)
    && t.functionDeclarations.some((f) => f?.name === "web_search")
}

/**
 * Detect web_search-style tools in a Gemini generateContent request.
 * Matches Google's hosted grounding (`googleSearch`) and any custom
 * function declaration named `web_search`.
 */
export function hasGeminiWebSearch(body: GeminiGenerateContentRequest): boolean {
  const tools = body.tools as GeminiToolLike[] | undefined
  if (!Array.isArray(tools)) return false
  return tools.some((t) => hasHostedSearch(t) || hasFunctionWebSearch(t))
}

/**
 * Strip every hosted search marker and the literal `web_search` function
 * declaration. The OpenAI interceptor will re-inject a normalised function
 * tool that the upstream Copilot model can actually invoke.
 */
function stripGeminiWebSearchTools(
  tools?: GeminiToolLike[],
): GeminiToolLike[] | undefined {
  if (!Array.isArray(tools)) return undefined
  const cleaned: GeminiToolLike[] = []
  for (const t of tools) {
    if (hasHostedSearch(t)) {
      // Drop hosted-search-only tools entirely; if other markers exist on
      // the same object, keep the rest (defensive — unlikely in practice).
      const { googleSearch: _gs, googleSearchRetrieval: _gsr, google_search: _gs2, ...rest } = t
      void _gs; void _gsr; void _gs2
      if (Object.keys(rest).length === 0) continue
      // Strip web_search from any remaining functionDeclarations.
      if (Array.isArray(rest.functionDeclarations)) {
        rest.functionDeclarations = rest.functionDeclarations.filter(
          (f) => f?.name !== "web_search",
        )
        if (rest.functionDeclarations.length === 0) continue
      }
      cleaned.push(rest)
      continue
    }
    if (Array.isArray(t.functionDeclarations)) {
      const fd = t.functionDeclarations.filter((f) => f?.name !== "web_search")
      if (fd.length === 0) continue
      cleaned.push({ ...t, functionDeclarations: fd })
      continue
    }
    cleaned.push(t)
  }
  return cleaned.length > 0 ? cleaned : undefined
}

export interface InterceptGeminiOptions {
  copilotToken: string
  accountType: AccountType
  engineOptions: EngineManagerOptions
}

export interface InterceptGeminiResult {
  chatResponse: OpenAIChatResponse
  geminiResponse: ReturnType<typeof translateOpenAIToGemini>
  meta: WebSearchMeta
}

/**
 * Run the chat-space web_search loop for a Gemini generateContent request:
 *   Gemini payload → OpenAI Chat payload (with web_search tool injected) →
 *   multi-turn loop → OpenAI Chat response → Gemini response.
 *
 * Streaming clients should synthesize a ChatCompletionChunk from the
 * returned `chatResponse` and feed it into the existing chunk→Gemini
 * transform pipeline.
 */
export async function interceptGeminiViaChat(
  body: GeminiGenerateContentRequest,
  model: string,
  options: InterceptGeminiOptions,
): Promise<InterceptGeminiResult> {
  // Strip Google hosted/function search markers before translating so the
  // translator doesn't try to forward them as unknown OpenAI tools.
  const cleaned: GeminiGenerateContentRequest = {
    ...body,
    tools: stripGeminiWebSearchTools(body.tools as GeminiToolLike[] | undefined) as GeminiGenerateContentRequest["tools"],
  }

  const openAIPayload = translateGeminiToOpenAI(cleaned, model)
  // Force non-stream — the loop is synchronous; caller replays.
  const interceptPayload: OpenAIChatPayload = {
    ...(openAIPayload as unknown as OpenAIChatPayload),
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

  const geminiResponse = translateOpenAIToGemini(
    chatResponse as unknown as ChatCompletionResponse,
    model,
  )

  return { chatResponse, geminiResponse, meta }
}
