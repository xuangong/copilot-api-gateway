import { getCopilotBaseUrl, type AccountType } from "./account-type"
import { copilotHeaders } from "./headers"
import { HTTPError } from "./lib/error"
import { fetchWithRetry, truncateBody } from "@vibe-core/http"
import type { Fetcher } from "@vibe-core/upstream"

interface CallCopilotAPIOptions {
  endpoint: string
  /** FormData is the multipart `/v1/images/edits` body, forwarded as-is. */
  payload: Record<string, unknown> | FormData
  operationName: string
  copilotToken: string
  accountType: AccountType
  /** Override the base URL derived from accountType. When set, the request
   *  goes to `${baseUrl}${endpoint}` instead of getCopilotBaseUrl(accountType).
   *  Used by GHE-with-data-residency tenants that advertise a per-tenant
   *  Copilot host (e.g. https://copilot-api.msft.ghe.com). */
  baseUrl?: string
  requireModel?: boolean
  timeout?: number // Request timeout in milliseconds
  extraHeaders?: Record<string, string>
  fetcher?: Fetcher
  preparedCall?: PreparedCopilotCall
}

export interface PreparedCopilotCall {
  ready: boolean
  body: string | FormData | undefined
  isStreaming: boolean
}

/**
 * Generic function to call Copilot API with transparent forwarding
 */
export async function callCopilotAPI({
  endpoint,
  payload,
  operationName,
  copilotToken,
  accountType,
  baseUrl: baseUrlOverride,
  requireModel = true,
  timeout,
  extraHeaders,
  fetcher,
  preparedCall,
}: CallCopilotAPIOptions): Promise<Response> {
  if (!copilotToken) {
    throw new Error("Copilot token not found")
  }

  const form = payload instanceof FormData ? payload : undefined
  const json = payload instanceof FormData ? undefined : payload

  if (!preparedCall?.ready) {
    const model = form ? form.get("model") : json?.model
    if (requireModel && (!model || typeof model !== "string")) {
      throw new Error("Model is required and must be a string")
    }

    // Normalize Claude model IDs: Anthropic SDK uses dashes (claude-opus-4-6-1m)
    // but Copilot API uses dots (claude-opus-4.6-1m). Convert version separators.
    if (json && typeof json.model === "string" && json.model.startsWith("claude-")) {
      // Match patterns like claude-opus-4-6-1m or claude-sonnet-4-5
      // Version numbers use dashes in SDK but dots in Copilot
      json.model = json.model.replace(
        /^(claude-(?:opus|sonnet|haiku)-)((\d)-(\d)(-1m)?)$/,
        (_match, prefix, _ver, major, minor, suffix = "") => `${prefix}${major}.${minor}${suffix}`,
      )
    }
  }

  const baseUrl = baseUrlOverride ?? getCopilotBaseUrl(accountType)
  const isStreaming = preparedCall?.ready ? preparedCall.isStreaming : json?.stream === true
  const requestId = crypto.randomUUID().slice(0, 8)

  // Log sync requests for debugging (they can hang)
  if (!isStreaming && endpoint === "/v1/messages") {
    console.log(`[upstream] ${requestId} sync request started, timeout=${timeout ? `${timeout/1000}s` : "none"}`)
  }

  // An empty string in extraHeaders is a sentinel meaning "delete this
  // header", not "send an empty value" — setClaudeAgentHeaders relies on it to
  // strip copilot-integration-id. A plain object spread cannot express that,
  // so merge through Headers. Do not revert this to `{ ...a, ...b }`.
  const headers = new Headers(copilotHeaders(copilotToken))
  for (const [name, value] of Object.entries(extraHeaders ?? {})) {
    if (value === "") headers.delete(name)
    else headers.set(name, value)
  }
  // fetch derives the multipart boundary from a FormData body.
  if (form) headers.delete("content-type")

  let response: Response
  try {
    const body = preparedCall?.ready ? preparedCall.body : form ?? JSON.stringify(json)
    if (preparedCall && !preparedCall.ready) {
      preparedCall.body = body
      preparedCall.isStreaming = isStreaming
      preparedCall.ready = true
    }
    response = await fetchWithRetry(`${baseUrl}${endpoint}`, {
      method: "POST",
      headers,
      body,
      timeout,
      fetchImpl: fetcher,
    })
  } catch (error) {
    if (!isStreaming && endpoint === "/v1/messages") {
      const errMsg = error instanceof Error ? error.message : String(error)
      console.log(`[upstream] ${requestId} sync request failed: ${errMsg}`)
    }
    throw error
  }

  if (!isStreaming && endpoint === "/v1/messages") {
    console.log(`[upstream] ${requestId} sync request completed: ${response.status}`)
  }

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "")
    let errorDetail: string
    try {
      const parsed = JSON.parse(errorBody)
      errorDetail = JSON.stringify(parsed)
    } catch {
      errorDetail = truncateBody(errorBody)
    }

    // Include full error detail in the message for logging
    const fullMessage = `Failed to ${operationName}: ${response.status} ${errorDetail}`
    console.log(fullMessage)

    throw new HTTPError(
      fullMessage,
      new Response(errorBody, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      }),
    )
  }

  return response
}

interface ToolUseBlock {
  type: "tool_use"
  id: string
}

interface ToolResultBlock {
  type: "tool_result"
  tool_use_id: string
}

type ContentBlock = ToolUseBlock | ToolResultBlock | { type: string }

interface Message {
  role?: string
  content?: ContentBlock[] | string
}

/**
 * Ensure every tool_use block has a matching tool_result in the next message.
 * Missing tool_results are filled with an empty error stub.
 */
export function repairToolResultPairs(messages: Message[]): Message[] {
  const result = [...messages]

  for (let i = 0; i < result.length - 1; i++) {
    const msg = result[i]
    if (msg?.role !== "assistant" || !Array.isArray(msg.content)) continue

    const toolUseIds = (msg.content as ContentBlock[])
      .filter((b): b is ToolUseBlock => b.type === "tool_use" && "id" in b)
      .map((b) => b.id)
    if (toolUseIds.length === 0) continue

    const next = result[i + 1]
    const nextContent = Array.isArray(next?.content)
      ? [...(next.content as ContentBlock[])]
      : []
    const existingIds = new Set(
      nextContent
        .filter((b): b is ToolResultBlock => b.type === "tool_result")
        .map((b) => b.tool_use_id),
    )

    const missing = toolUseIds.filter((id) => !existingIds.has(id))
    if (missing.length === 0) continue

    for (const id of missing) {
      nextContent.push({
        type: "tool_result",
        tool_use_id: id,
      } as ToolResultBlock)
    }

    if (next?.role === "user") {
      result[i + 1] = { ...next, content: nextContent }
    } else {
      result.splice(i + 1, 0, { role: "user", content: nextContent })
      i++ // skip the inserted message
    }
  }

  return result
}
