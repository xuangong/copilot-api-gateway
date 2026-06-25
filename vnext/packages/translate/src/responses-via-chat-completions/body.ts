/**
 * Non-streaming translator: Chat Completion upstream JSON → Responses JSON.
 *
 * Direction: body = hub → client. Maps a single Chat completion into a
 * Responses object. Assistant text becomes a `message` item with one
 * `output_text` part; `tool_calls` become `function_call` items.
 * `finish_reason: 'length'` maps to `status: 'incomplete'` with
 * `incomplete_details.reason: 'max_output_tokens'`; otherwise `completed`.
 * Usage tokens are mapped (`prompt_tokens`/`completion_tokens` →
 * `input_tokens`/`output_tokens`).
 *
 * Envelope parity with root (src/services/responses/format-conversion.ts):
 * we accept the original Responses-shape request payload (`sourcePayload`)
 * so we can echo back the request-side fields the upstream Chat-Completions
 * response never carries (`instructions`, `metadata`, `parallel_tool_calls`,
 * `temperature`, `tool_choice`, `tools`, `top_p`) and synthesize fields the
 * Responses API requires but the Chat shape lacks (`output_text`, per-output
 * `id`/`status`, `annotations:[]`, `error:null`, `incomplete_details:null`,
 * detailed `usage.{input_tokens_details,output_tokens_details,total_tokens}`).
 */
interface ChatToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
interface ChatMessage { role: 'assistant'; content: string | null; tool_calls?: ChatToolCall[] }
interface ChatBody {
  id: string
  model?: string
  created?: number
  choices: Array<{ index: number; message: ChatMessage; finish_reason: 'stop' | 'length' | 'tool_calls' | 'function_call' | null }>
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

interface ResponsesOutputContentPart {
  type: 'output_text'
  text: string
  annotations: unknown[]
}
interface ResponsesOutputItem {
  type: 'message' | 'function_call'
  id?: string
  status?: 'completed' | 'incomplete'
  role?: 'assistant'
  content?: ResponsesOutputContentPart[]
  call_id?: string
  name?: string
  arguments?: string
}

interface ResponsesUsage {
  input_tokens: number
  input_tokens_details: { cached_tokens: number }
  output_tokens: number
  output_tokens_details: { reasoning_tokens: number }
  total_tokens: number
}

interface ResponsesBody {
  id: string
  object: 'response'
  created_at: number
  model: string
  output: ResponsesOutputItem[]
  output_text: string
  status: 'completed' | 'incomplete'
  error: null
  incomplete_details: { reason: string } | null
  instructions: unknown
  metadata: unknown
  parallel_tool_calls: boolean
  temperature: unknown
  tool_choice: unknown
  tools: unknown
  top_p: unknown
  usage?: ResponsesUsage
}

interface SourcePayload {
  instructions?: unknown
  metadata?: unknown
  parallel_tool_calls?: boolean
  temperature?: unknown
  tool_choice?: unknown
  tools?: unknown
  top_p?: unknown
}

let msgIdCounter = 0
const generateMessageId = (): string => {
  // Mirrors root's `msg_<rand>` pattern. Doesn't need cryptographic strength —
  // just stable within a single response so clients can correlate parts.
  msgIdCounter = (msgIdCounter + 1) & 0xffff_ffff
  const rand = Math.random().toString(36).slice(2, 10)
  return `msg_${Date.now().toString(36)}${rand}${msgIdCounter.toString(36)}`
}

export function translateChatToResponsesBody(
  body: unknown,
  ctx?: { sourcePayload?: SourcePayload },
): ResponsesBody {
  const c = body as ChatBody
  const choice = c.choices[0]
  const source: SourcePayload = ctx?.sourcePayload ?? {}

  const output: ResponsesOutputItem[] = []
  let outputText = ''

  if (choice && typeof choice.message.content === 'string' && choice.message.content.length > 0) {
    outputText = choice.message.content
    output.push({
      type: 'message',
      id: generateMessageId(),
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: outputText, annotations: [] }],
    })
  }
  if (choice?.message.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      output.push({
        type: 'function_call',
        call_id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
      })
    }
  }

  const status: 'completed' | 'incomplete' = choice?.finish_reason === 'length' ? 'incomplete' : 'completed'
  const out: ResponsesBody = {
    id: c.id,
    object: 'response',
    created_at: c.created ?? Math.floor(Date.now() / 1000),
    model: c.model ?? '',
    output,
    output_text: outputText,
    status,
    error: null,
    incomplete_details: status === 'incomplete' ? { reason: 'max_output_tokens' } : null,
    instructions: source.instructions ?? null,
    metadata: source.metadata ?? null,
    parallel_tool_calls: source.parallel_tool_calls ?? true,
    temperature: source.temperature ?? null,
    tool_choice: source.tool_choice ?? 'auto',
    tools: source.tools ?? [],
    top_p: source.top_p ?? null,
  }
  if (c.usage) {
    const inputTokens = c.usage.prompt_tokens ?? 0
    const outputTokens = c.usage.completion_tokens ?? 0
    out.usage = {
      input_tokens: inputTokens,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: outputTokens,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: inputTokens + outputTokens,
    }
  }
  return out
}
