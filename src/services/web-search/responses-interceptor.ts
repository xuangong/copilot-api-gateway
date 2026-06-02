import type { AccountType } from "~/config/constants"
import { getRepo } from "~/repo"
import type { ResponsesItemRecord } from "~/repo/types"
import {
  translateResponsesToChatCompletions,
  translateChatCompletionsToResponses,
  type ChatCompletionResponse,
  type ResponsesAPIResponse,
} from "~/services/responses"
import type {
  ResponseFunctionCallItem,
  ResponseFunctionCallOutputItem,
  ResponseInputItem,
  ResponsesPayload,
  ResponseTool,
  ResponseWebSearchCallItem,
} from "~/transforms/types"

import type { EngineManagerOptions } from "./engine-manager"
import {
  interceptOpenAIChat,
  type InterceptedSearch,
  type OpenAIChatPayload,
  type OpenAIChatResponse,
} from "./openai-interceptor"
import type { WebSearchMeta } from "./types"

const RESPONSES_WEB_SEARCH_TYPES = new Set(["web_search", "web_search_preview"])

const WS_GW_ID_RE = /^ws_gw_[0-9a-f]{24}$/

/** Mint a gateway-side id for a freshly executed web_search_call. */
function mintWsGwId(): string {
  // crypto.randomUUID() = 8-4-4-4-12 hex w/ dashes. Strip and slice to 24 hex.
  return `ws_gw_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`
}

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

/** Gateway-side state we persist next to a web_search_call item. */
interface PrivateWsPayload {
  query: string
  content: string
  /** chat-side tool_call_id; reused on replay so assistant+tool messages pair up. */
  chatToolCallId: string
}

/**
 * Restore step: walk payload.input, replace every echoed `web_search_call`
 * item (whose id we recognise via the repo) with an equivalent
 * `function_call` + `function_call_output` pair so the existing chat
 * translator turns it into the assistant(tool_calls) + tool(result) pair
 * the model expects.
 *
 * Returns the rewritten input plus the list of restored item ids (so we
 * can re-emit them in the output verbatim — clients expect echoed items
 * back in the new response).
 */
async function restoreEchoedWebSearchItems(
  input: ResponsesPayload["input"],
  apiKeyId: string | undefined,
): Promise<{
  rewrittenInput: ResponsesPayload["input"]
  restored: Array<{ id: string; query: string }>
}> {
  if (!Array.isArray(input)) return { rewrittenInput: input, restored: [] }

  // Collect candidate ids first so we can batch the lookup.
  const candidateIds: string[] = []
  for (const item of input) {
    if (item.type === "web_search_call" && WS_GW_ID_RE.test(item.id)) {
      candidateIds.push(item.id)
    }
  }
  if (candidateIds.length === 0) return { rewrittenInput: input, restored: [] }

  const repo = getRepo()
  // Scope by api key when known so a client can't read another account's
  // persisted search results by echoing a foreign ws_gw_* id. When apiKeyId
  // is undefined (admin path / tests) fall back to the broad lookup.
  const records = await repo.responsesItems.lookupMany(candidateIds, apiKeyId)
  const byId = new Map<string, ResponsesItemRecord>()
  for (const r of records) byId.set(r.id, r)

  const rewrittenInput: ResponseInputItem[] = []
  const restored: Array<{ id: string; query: string }> = []
  for (const item of input) {
    if (item.type === "web_search_call" && byId.has(item.id)) {
      const rec = byId.get(item.id)!
      let priv: PrivateWsPayload | null = null
      try {
        priv = rec.privateJson ? JSON.parse(rec.privateJson) as PrivateWsPayload : null
      } catch {
        priv = null
      }
      if (!priv) {
        // Row exists but payload is missing/corrupt. Surface a placeholder
        // so the model knows a prior search happened but its results are no
        // longer available — better than silently vanishing the turn.
        const lostCallId = `ws_lost_${item.id.slice(-12)}`
        rewrittenInput.push(
          {
            type: "function_call",
            call_id: lostCallId,
            name: "web_search",
            arguments: JSON.stringify({ query: "" }),
          } satisfies ResponseFunctionCallItem,
          {
            type: "function_call_output",
            call_id: lostCallId,
            output: "[web_search results from a previous turn are no longer available]",
          } satisfies ResponseFunctionCallOutputItem,
        )
        continue
      }
      const fc: ResponseFunctionCallItem = {
        type: "function_call",
        call_id: priv.chatToolCallId,
        name: "web_search",
        arguments: JSON.stringify({ query: priv.query }),
      }
      const fco: ResponseFunctionCallOutputItem = {
        type: "function_call_output",
        call_id: priv.chatToolCallId,
        output: priv.content,
      }
      rewrittenInput.push(fc, fco)
      restored.push({ id: item.id, query: priv.query })
      continue
    }
    if (item.type === "web_search_call") {
      // Unknown id (TTL'd, foreign api key, wrong gateway, …). Emit the same
      // placeholder pair so the model sees the gap rather than nothing — and
      // never trust the wire-side `results` field the client may have kept.
      const lostCallId = `ws_lost_${item.id.slice(-12)}`
      rewrittenInput.push(
        {
          type: "function_call",
          call_id: lostCallId,
          name: "web_search",
          arguments: JSON.stringify({ query: "" }),
        } satisfies ResponseFunctionCallItem,
        {
          type: "function_call_output",
          call_id: lostCallId,
          output: "[web_search results from a previous turn are no longer available]",
        } satisfies ResponseFunctionCallOutputItem,
      )
      continue
    }
    rewrittenInput.push(item)
  }
  return { rewrittenInput, restored }
}

/**
 * Persist step: for every new web_search the loop ran this turn, mint a
 * `ws_gw_*` id and write a `responses_items` row carrying the public
 * web_search_call envelope plus the private result content needed to
 * replay on the next turn.
 */
async function persistNewSearches(
  apiKeyId: string | undefined,
  searches: InterceptedSearch[],
  ttlMs: number,
): Promise<Array<{ id: string; query: string; isError: boolean }>> {
  if (searches.length === 0) return []
  const now = new Date()
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString()
  const records: ResponsesItemRecord[] = []
  const minted: Array<{ id: string; query: string; isError: boolean }> = []
  for (const s of searches) {
    const id = mintWsGwId()
    const itemJson = JSON.stringify({
      type: "web_search_call",
      id,
      status: s.isError ? "failed" : "completed",
      action: { type: "search", query: s.query },
    })
    const privateJson = JSON.stringify({
      query: s.query,
      content: s.content,
      chatToolCallId: s.toolCallId,
    } satisfies PrivateWsPayload)
    records.push({
      id,
      apiKeyId: apiKeyId ?? null,
      kind: "web_search_call",
      itemJson,
      privateJson,
      createdAt: now.toISOString(),
      expiresAt,
    })
    minted.push({ id, query: s.query, isError: s.isError })
  }
  try {
    await getRepo().responsesItems.insertMany(records)
  } catch (err) {
    console.error("[Web Search] Failed to persist responses_items:", err)
    // Persistence failure doesn't fail the request — the SDK just can't replay later.
  }
  return minted
}

export interface InterceptResponsesOptions {
  copilotToken: string
  accountType: AccountType
  engineOptions: EngineManagerOptions
  /** Owning api key id — required for persistence; if absent, items are still minted but stored with null owner. */
  apiKeyId?: string
  /** TTL for persisted items. Default 24h. */
  itemTtlMs?: number
}

export interface InterceptedWebSearchItem {
  id: string
  query: string
  isError: boolean
}

export interface InterceptResponsesResult {
  responsesResult: ResponsesAPIResponse
  chatResponse: OpenAIChatResponse
  meta: WebSearchMeta
  /** Echoed back from a prior turn; we re-emit them so the client sees a stable id chain. */
  restoredItems: Array<{ id: string; query: string }>
  /** Newly minted this turn; persisted to repo for the next turn to replay. */
  mintedItems: InterceptedWebSearchItem[]
}

const DEFAULT_ITEM_TTL_MS = 24 * 60 * 60 * 1000

/**
 * Run the chat-fallback Responses intercept loop:
 *   Responses payload → (restore echoed web_search_call items) →
 *   Chat payload → multi-turn web_search loop → Chat response →
 *   Responses response (with restored + minted web_search_call items
 *   spliced into output).
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

  const { rewrittenInput, restored } = await restoreEchoedWebSearchItems(
    payload.input,
    options.apiKeyId,
  )

  const cleanedPayload: ResponsesPayload = {
    ...payload,
    input: rewrittenInput,
    tools: stripResponsesWebSearchTools(payload.tools),
  }

  const chatPayload = translateResponsesToChatCompletions(cleanedPayload, model)
  const interceptPayload: OpenAIChatPayload = {
    ...(chatPayload as unknown as OpenAIChatPayload),
    stream: false,
  }

  const { response: chatResponse, meta, searches } = await interceptOpenAIChat(
    interceptPayload,
    {
      copilotToken: options.copilotToken,
      accountType: options.accountType,
      engineOptions: options.engineOptions,
    },
  )

  const minted = await persistNewSearches(
    options.apiKeyId,
    searches,
    options.itemTtlMs ?? DEFAULT_ITEM_TTL_MS,
  )

  const responsesResult = translateChatCompletionsToResponses(
    chatResponse as unknown as ChatCompletionResponse,
    model,
    payload,
  )

  // Splice web_search_call items into output ahead of the message item so
  // SDK clients see them with the gateway-minted ids.
  const synthesisedItems: ResponseWebSearchCallItem[] = [
    ...restored.map((r): ResponseWebSearchCallItem => ({
      type: "web_search_call",
      id: r.id,
      status: "completed",
      action: { type: "search", query: r.query },
    })),
    ...minted.map((m): ResponseWebSearchCallItem => ({
      type: "web_search_call",
      id: m.id,
      status: m.isError ? "failed" : "completed",
      action: { type: "search", query: m.query },
    })),
  ]
  if (synthesisedItems.length > 0) {
    responsesResult.output = [
      ...synthesisedItems as unknown as typeof responsesResult.output,
      ...responsesResult.output,
    ]
  }

  return {
    responsesResult,
    chatResponse,
    meta,
    restoredItems: restored,
    mintedItems: minted,
  }
}
