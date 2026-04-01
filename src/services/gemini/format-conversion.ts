import type {
  GeminiGenerateContentRequest,
  GeminiGenerateContentResponse,
  GeminiContent,
  GeminiPart,
  GeminiStreamChunk,
  GeminiStreamState,
  GeminiFinishReason,
  GeminiCandidate,
} from "./types"

// OpenAI Chat Completions types (subset needed for conversion)

export interface ChatCompletionsPayload {
  model: string
  messages: Message[]
  max_tokens?: number
  temperature?: number
  top_p?: number
  stop?: string[]
  tools?: Tool[]
  tool_choice?: "auto" | "required" | "none" | { type: "function"; function: { name: string } }
  n?: number
  stream?: boolean
  response_format?: { type: "json_object" | "text" }
}

export interface Message {
  role: "system" | "user" | "assistant" | "tool"
  content: string | ContentPart[] | null
  tool_calls?: ToolCall[]
  tool_call_id?: string
}

export interface ContentPart {
  type: "text" | "image_url"
  text?: string
  image_url?: { url: string }
}

export interface Tool {
  type: "function"
  function: {
    name: string
    description?: string
    parameters: Record<string, unknown>
  }
}

export interface ToolCall {
  id: string
  type: "function"
  function: {
    name: string
    arguments: string
  }
}

export interface ChatCompletionResponse {
  id: string
  object: "chat.completion"
  created: number
  model: string
  choices: ChatCompletionChoice[]
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

export interface ChatCompletionChoice {
  index: number
  message: {
    role: "assistant"
    content: string | null
    tool_calls?: ToolCall[]
  }
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null
}

export interface ChatCompletionChunk {
  id: string
  object: "chat.completion.chunk"
  created: number
  model: string
  choices: ChatCompletionChunkChoice[]
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

export interface ChatCompletionChunkChoice {
  index: number
  delta: {
    role?: "assistant"
    content?: string
    tool_calls?: Array<{
      index: number
      id?: string
      type?: "function"
      function?: {
        name?: string
        arguments?: string
      }
    }>
  }
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null
}

// Gemini -> OpenAI (for sending to Copilot)

export function translateGeminiToOpenAI(
  request: GeminiGenerateContentRequest,
  model: string,
): ChatCompletionsPayload {
  const messages: Message[] = []

  // Handle system instruction
  if (request.systemInstruction) {
    const systemText = extractTextFromContent(request.systemInstruction)
    if (systemText) {
      messages.push({ role: "system", content: systemText })
    }
  }

  // Handle contents
  const contentsArray = Array.isArray(request.contents)
    ? request.contents
    : [{ role: "user" as const, parts: [{ text: request.contents }] }]

  for (const content of contentsArray) {
    convertContentToMessages(content, messages)
  }

  // Handle tools
  const tools = translateGeminiToolsToOpenAI(request.tools)

  // Handle tool choice
  const toolChoice = translateGeminiToolConfigToOpenAI(request.toolConfig)

  return {
    model,
    messages,
    max_tokens: request.generationConfig?.maxOutputTokens,
    temperature: request.generationConfig?.temperature,
    top_p: request.generationConfig?.topP,
    stop: request.generationConfig?.stopSequences,
    tools,
    tool_choice: toolChoice,
    n: request.generationConfig?.candidateCount,
    response_format:
      request.generationConfig?.responseMimeType === "application/json"
        ? { type: "json_object" }
        : undefined,
  }
}

function convertContentToMessages(
  content: GeminiContent,
  messages: Message[],
) {
  const role = mapGeminiRoleToOpenAI(content.role)
  const convertedContent = convertGeminiPartsToOpenAI(content.parts)

  if (role === "tool") {
    // Handle function responses as tool messages
    for (const part of content.parts) {
      if ("functionResponse" in part) {
        messages.push({
          role: "tool",
          tool_call_id: part.functionResponse.name,
          content: JSON.stringify(part.functionResponse.response),
        })
      }
    }
  } else if (role === "assistant" && hasFunctionCall(content.parts)) {
    // Handle assistant messages with function calls
    const textContent = extractTextFromParts(content.parts)
    const toolCalls = extractToolCalls(content.parts)
    messages.push({
      role: "assistant",
      content: textContent || null,
      tool_calls: toolCalls,
    })
  } else {
    messages.push({ role, content: convertedContent })
  }
}

function mapGeminiRoleToOpenAI(
  role?: "user" | "model",
): "user" | "assistant" | "tool" {
  if (role === "model") return "assistant"
  return "user"
}

function extractTextFromContent(content: GeminiContent): string {
  return content.parts
    .filter((part): part is { text: string } => "text" in part)
    .map((part) => part.text)
    .join("")
}

function extractTextFromParts(parts: GeminiPart[]): string {
  return parts
    .filter((part): part is { text: string } => "text" in part)
    .map((part) => part.text)
    .join("")
}

function hasFunctionCall(parts: GeminiPart[]): boolean {
  return parts.some((part) => "functionCall" in part)
}

function extractToolCalls(parts: GeminiPart[]): ToolCall[] {
  return parts
    .filter(
      (part): part is {
        functionCall: { name: string; args: Record<string, unknown> }
      } => "functionCall" in part,
    )
    .map((part, index) => ({
      id: `call_${part.functionCall.name}_${index}`,
      type: "function" as const,
      function: {
        name: part.functionCall.name,
        arguments: JSON.stringify(part.functionCall.args),
      },
    }))
}

function convertGeminiPartsToOpenAI(
  parts: GeminiPart[],
): string | ContentPart[] {
  const hasImage = parts.some((part) => "inlineData" in part)

  if (!hasImage) {
    return extractTextFromParts(parts)
  }

  const contentParts: ContentPart[] = []
  for (const part of parts) {
    if ("text" in part) {
      contentParts.push({ type: "text", text: part.text })
    } else if ("inlineData" in part) {
      contentParts.push({
        type: "image_url",
        image_url: {
          url: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`,
        },
      })
    }
  }
  return contentParts
}

function translateGeminiToolsToOpenAI(
  tools?: Array<{
    functionDeclarations?: Array<{
      name: string
      description?: string
      parameters?: Record<string, unknown>
    }>
  }>,
): Tool[] | undefined {
  if (!tools) return undefined

  const result: Tool[] = []
  for (const tool of tools) {
    if (tool.functionDeclarations) {
      for (const func of tool.functionDeclarations) {
        result.push({
          type: "function",
          function: {
            name: func.name,
            description: func.description,
            parameters: func.parameters || {},
          },
        })
      }
    }
  }
  return result.length > 0 ? result : undefined
}

function translateGeminiToolConfigToOpenAI(config?: {
  functionCallingConfig?: {
    mode?: "AUTO" | "ANY" | "NONE"
    allowedFunctionNames?: string[]
  }
}): ChatCompletionsPayload["tool_choice"] {
  if (!config?.functionCallingConfig) return undefined

  const mode = config.functionCallingConfig.mode
  switch (mode) {
    case "AUTO":
      return "auto"
    case "ANY":
      return "required"
    case "NONE":
      return "none"
    default:
      return undefined
  }
}

// OpenAI -> Gemini (for returning to client)

export function translateOpenAIToGemini(
  response: ChatCompletionResponse,
  modelName: string,
): GeminiGenerateContentResponse {
  const candidates: GeminiCandidate[] = response.choices.map(
    (choice, index) => {
      const parts: GeminiPart[] = []

      // Add text content
      if (choice.message.content) {
        parts.push({ text: choice.message.content })
      }

      // Add function calls
      if (choice.message.tool_calls) {
        for (const toolCall of choice.message.tool_calls) {
          parts.push({
            functionCall: {
              name: toolCall.function.name,
              args: JSON.parse(toolCall.function.arguments) as Record<
                string,
                unknown
              >,
            },
          })
        }
      }

      return {
        content: {
          role: "model" as const,
          parts,
        },
        finishReason: mapOpenAIFinishReasonToGemini(choice.finish_reason),
        index,
      }
    },
  )

  return {
    candidates,
    usageMetadata: response.usage
      ? {
          promptTokenCount: response.usage.prompt_tokens,
          candidatesTokenCount: response.usage.completion_tokens,
          totalTokenCount: response.usage.total_tokens,
        }
      : undefined,
    modelVersion: modelName,
  }
}

function mapOpenAIFinishReasonToGemini(
  reason: "stop" | "length" | "tool_calls" | "content_filter" | null,
): GeminiFinishReason {
  switch (reason) {
    case "stop":
      return "STOP"
    case "length":
      return "MAX_TOKENS"
    case "tool_calls":
      return "STOP"
    case "content_filter":
      return "SAFETY"
    default:
      return "FINISH_REASON_UNSPECIFIED"
  }
}

// Streaming translation

export function translateChunkToGemini(
  chunk: ChatCompletionChunk,
  state: GeminiStreamState,
): GeminiStreamChunk | null {
  if (chunk.choices.length === 0) {
    return null
  }

  const choice = chunk.choices[0]
  if (!choice) {
    return null
  }

  const { delta } = choice

  const parts: GeminiPart[] = []

  if (delta.content) {
    parts.push({ text: delta.content })
    state.accumulatedText += delta.content
    state.contentStarted = true
  }

  if (delta.tool_calls) {
    for (const toolCall of delta.tool_calls) {
      if (toolCall.function?.name) {
        parts.push({
          functionCall: {
            name: toolCall.function.name,
            args: toolCall.function.arguments
              ? (JSON.parse(toolCall.function.arguments) as Record<
                  string,
                  unknown
                >)
              : {},
          },
        })
      }
    }
  }

  if (choice.finish_reason) {
    state.finishReason = mapOpenAIFinishReasonToGemini(choice.finish_reason)
  }

  if (chunk.usage) {
    state.usage = {
      promptTokenCount: chunk.usage.prompt_tokens,
      candidatesTokenCount: chunk.usage.completion_tokens,
      totalTokenCount: chunk.usage.total_tokens,
    }
  }

  if (parts.length === 0 && !choice.finish_reason) {
    return null
  }

  return {
    candidates: [
      {
        content: {
          role: "model",
          parts: parts.length > 0 ? parts : [{ text: "" }],
        },
        finishReason: state.finishReason,
      },
    ],
    usageMetadata: state.usage,
    modelVersion: state.model,
  }
}

// Helper to create initial stream state
export function createStreamState(model: string): GeminiStreamState {
  return {
    model,
    contentStarted: false,
    accumulatedText: "",
  }
}
