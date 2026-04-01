import { getCopilotBaseUrl, type AccountType } from "~/config/constants"
import { copilotHeaders } from "~/config/headers"
import { HTTPError } from "~/lib/error"
import { fetchWithRetry } from "~/lib/fetch-retry"

interface CallCopilotAPIOptions {
  endpoint: string
  payload: Record<string, unknown>
  operationName: string
  copilotToken: string
  accountType: AccountType
  requireModel?: boolean
  timeout?: number // Request timeout in milliseconds
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
  requireModel = true,
  timeout,
}: CallCopilotAPIOptions): Promise<Response> {
  if (!copilotToken) {
    throw new Error("Copilot token not found")
  }

  if (requireModel && (!payload.model || typeof payload.model !== "string")) {
    throw new Error("Model is required and must be a string")
  }

  const baseUrl = getCopilotBaseUrl(accountType)
  const isStreaming = payload.stream === true
  const requestId = crypto.randomUUID().slice(0, 8)

  // Log sync requests for debugging (they can hang)
  if (!isStreaming && endpoint === "/v1/messages") {
    console.log(`[upstream] ${requestId} sync request started, timeout=${timeout ? `${timeout/1000}s` : "none"}`)
  }

  let response: Response
  try {
    response = await fetchWithRetry(`${baseUrl}${endpoint}`, {
      method: "POST",
      headers: copilotHeaders(copilotToken),
      body: JSON.stringify(payload),
      timeout,
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
      errorDetail =
        errorBody.length > 200
          ? errorBody.slice(0, 200) + "...(truncated)"
          : errorBody
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
