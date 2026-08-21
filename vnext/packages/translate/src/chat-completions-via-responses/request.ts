/**
 * Request translator: Chat Completions client → Responses upstream.
 *
 * Direction: request = client → hub. Used when the client speaks
 * /v1/chat/completions but the chosen model is served via /v1/responses.
 *
 * Faithful, minimal translation: knobs absent in the source are NOT
 * synthesized. Notable behaviors:
 *  - System messages are filtered out and joined with `\n\n` into Responses
 *    `instructions`.
 *  - User text becomes `input_text`; user `image_url` parts (string OR
 *    `{ url }` object) become `input_image`.
 *  - Assistant `tool_calls` map to `function_call` items; `tool` role
 *    messages map to `function_call_output`.
 *  - Custom tools become Responses `function` tools with `strict: false`.
 *    Non-function client tools (e.g. `web_search`) are dropped — they have
 *    no Chat→Responses analogue.
 *  - Top-level `web_search_options` becomes a hosted `web_search` tool entry;
 *    that is where Chat Completions puts the trigger (see below).
 *  - `max_tokens` (or `fallbackMaxOutputTokens` option) maps to
 *    `max_output_tokens`.
 */
import type { ChatPayload } from '@vibe-llm/protocols/chat'
import type { ResponsesPayload } from '@vibe-llm/protocols/responses'

export interface TranslateChatToResponsesOptions {
  fallbackMaxOutputTokens?: number
}
export interface ChatToResponsesRequestResult { target: ResponsesPayload }

type ChatMessage = ChatPayload['messages'][number]

interface ResponsesMessageItem {
  type: 'message'
  role: 'user' | 'assistant'
  content: string | Array<{ type: string; text?: string }>
}
interface ResponsesFunctionCallItem { type: 'function_call'; call_id: string; name: string; arguments: string }
interface ResponsesFunctionCallOutputItem { type: 'function_call_output'; call_id: string; output: string }
type ResponsesInputItem = ResponsesMessageItem | ResponsesFunctionCallItem | ResponsesFunctionCallOutputItem

type ResponsesTool =
  | { type: 'function'; name: string; description?: string; parameters?: unknown; strict: boolean }
  | { type: 'web_search'; search_context_size?: string; user_location?: unknown }

type ResponsesToolChoice = 'auto' | 'required' | 'none' | { type: 'function'; name: string }

function partsToContent(parts: unknown[]): Array<{ type: string; text?: string }> {
  const out: Array<{ type: string; text?: string }> = []
  for (const p of parts) {
    const part = p as { type?: string; text?: string; image_url?: { url?: string } | string }
    if (part.type === 'text' && typeof part.text === 'string') {
      out.push({ type: 'input_text', text: part.text })
    } else if (part.type === 'image_url') {
      const url = typeof part.image_url === 'string'
        ? part.image_url
        : part.image_url?.url
      if (url) out.push({ type: 'input_image', text: url })
    }
  }
  return out
}

function stringifyToolContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (content == null) return ''
  try { return JSON.stringify(content) } catch { return '' }
}

function translateInput(messages: ChatMessage[]): ResponsesInputItem[] {
  const out: ResponsesInputItem[] = []
  for (const m of messages) {
    if (m.role === 'system') continue // hoisted to instructions
    if (m.role === 'user') {
      if (typeof m.content === 'string') {
        out.push({ type: 'message', role: 'user', content: m.content })
      } else if (Array.isArray(m.content)) {
        out.push({ type: 'message', role: 'user', content: partsToContent(m.content) })
      }
      continue
    }
    if (m.role === 'assistant') {
      const am = m as ChatMessage & { tool_calls?: Array<{ id: string; function: { name: string; arguments?: string } }> }
      if (typeof am.content === 'string' && am.content.length > 0) {
        out.push({ type: 'message', role: 'assistant', content: am.content })
      }
      if (am.tool_calls) {
        for (const tc of am.tool_calls) {
          out.push({
            type: 'function_call',
            call_id: tc.id,
            name: tc.function.name,
            arguments: tc.function.arguments ?? '{}',
          })
        }
      }
      continue
    }
    if (m.role === 'tool') {
      const tm = m as ChatMessage & { tool_call_id: string; content: unknown }
      out.push({
        type: 'function_call_output',
        call_id: tm.tool_call_id,
        output: stringifyToolContent(tm.content),
      })
    }
  }
  return out
}

function joinSystem(messages: ChatMessage[]): string | undefined {
  const sys = messages
    .filter((m) => m.role === 'system')
    .map((m) => (typeof m.content === 'string' ? m.content : ''))
    .filter((s) => s.length > 0)
  if (sys.length === 0) return undefined
  return sys.join('\n\n')
}

function translateTools(tools: ChatPayload['tools']): ResponsesTool[] | undefined {
  if (!tools || tools.length === 0) return undefined
  const out: ResponsesTool[] = []
  for (const t of tools) {
    if (t.type !== 'function') continue
    const fn = t.function
    const tool: ResponsesTool = {
      type: 'function',
      name: fn.name,
      ...(fn.description ? { description: fn.description } : {}),
      parameters: fn.parameters,
      strict: false,
    }
    out.push(tool)
  }
  return out.length > 0 ? out : undefined
}

function translateToolChoice(choice: ChatPayload['tool_choice']): ResponsesToolChoice | undefined {
  if (choice === undefined) return undefined
  if (choice === 'auto' || choice === 'required' || choice === 'none') return choice
  if (typeof choice === 'object' && choice !== null && 'function' in choice) {
    const c = choice as { type?: string; function: { name: string } }
    return { type: 'function', name: c.function.name }
  }
  return undefined
}

/**
 * Hosted web search crosses the protocol boundary as a shape change, not a
 * field rename: Chat Completions expresses it as the top-level
 * `web_search_options` argument, Responses as a `tools[]` entry. Without this
 * a Chat Completions client silently loses search whenever the model is only
 * served on /responses (every `gpt-5*` on Copilot, per copilotModelEndpoints).
 *
 * Unlike the Messages counterpart, both options survive the trip: Responses'
 * `web_search` tool has the same `search_context_size` and `user_location`
 * knobs, so they are forwarded rather than dropped.
 */
function hostedWebSearchTool(options: unknown): ResponsesTool {
  const o = (options ?? {}) as { search_context_size?: unknown; user_location?: unknown }
  return {
    type: 'web_search',
    ...(typeof o.search_context_size === 'string' ? { search_context_size: o.search_context_size } : {}),
    ...(o.user_location !== undefined ? { user_location: o.user_location } : {}),
  }
}

/**
 * Native Responses — and the gateway's web-search shim, which mirrors it —
 * omit `web_search_call.results` from the wire unless the request opts in
 * with this `include` token. Chat Completions has no `include` argument, so a
 * client there cannot spell the opt-in; asking for search is therefore taken
 * as asking for the sources it produced. This is a deliberate departure from
 * otherwise-faithful translation: the alternative is a Chat Completions
 * client that can never see a citation, since `annotations[]` (its only
 * source channel) is built from exactly this field.
 */
const WEB_SEARCH_RESULTS_INCLUDE = 'web_search_call.results'

function withSearchResultsIncluded(existing: unknown): string[] {
  const include = Array.isArray(existing) ? (existing as string[]) : []
  return include.includes(WEB_SEARCH_RESULTS_INCLUDE)
    ? include
    : [...include, WEB_SEARCH_RESULTS_INCLUDE]
}

export function translateChatToResponses(
  payload: ChatPayload,
  options?: TranslateChatToResponsesOptions,
): ChatToResponsesRequestResult {
  const messages = payload.messages
  const target: Record<string, unknown> = {
    model: payload.model,
    input: translateInput(messages),
    stream: payload.stream ?? true,
  }
  const instructions = joinSystem(messages)
  if (instructions !== undefined) target.instructions = instructions
  if (payload.temperature !== undefined) target.temperature = payload.temperature
  if (payload.top_p !== undefined) target.top_p = payload.top_p
  const ext = payload as ChatPayload & { metadata?: Record<string, string> }
  if (ext.metadata) target.metadata = { ...ext.metadata }
  const tools = translateTools(payload.tools)
  if (tools) target.tools = tools
  const webSearchOptions = (payload as { web_search_options?: unknown }).web_search_options
  if (webSearchOptions !== undefined) {
    target.tools = [...((target.tools as ResponsesTool[]) ?? []), hostedWebSearchTool(webSearchOptions)]
    target.include = withSearchResultsIncluded((payload as { include?: unknown }).include)
  }
  const tc = translateToolChoice(payload.tool_choice)
  if (tc !== undefined) target.tool_choice = tc
  const cap = payload.max_tokens ?? options?.fallbackMaxOutputTokens
  if (cap !== undefined) target.max_output_tokens = cap
  return { target: target as unknown as ResponsesPayload }
}
