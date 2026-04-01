// Gemini API Types

// Request types

export interface GeminiGenerateContentRequest {
  contents: string | Array<GeminiContent>
  systemInstruction?: GeminiContent
  generationConfig?: GeminiGenerationConfig
  tools?: Array<GeminiTool>
  toolConfig?: GeminiToolConfig
  safetySettings?: Array<GeminiSafetySetting>
  cachedContent?: string
}

export interface GeminiContent {
  role?: "user" | "model"
  parts: Array<GeminiPart>
}

export type GeminiPart =
  | GeminiTextPart
  | GeminiInlineDataPart
  | GeminiFunctionCallPart
  | GeminiFunctionResponsePart

interface GeminiTextPart {
  text: string
}

interface GeminiInlineDataPart {
  inlineData: {
    mimeType: string
    data: string
  }
}

interface GeminiFunctionCallPart {
  functionCall: {
    name: string
    args: Record<string, unknown>
  }
}

interface GeminiFunctionResponsePart {
  functionResponse: {
    name: string
    response: Record<string, unknown>
  }
}

interface GeminiGenerationConfig {
  maxOutputTokens?: number
  temperature?: number
  topP?: number
  topK?: number
  stopSequences?: Array<string>
  candidateCount?: number
  responseMimeType?: string
  responseSchema?: Record<string, unknown>
}

interface GeminiTool {
  functionDeclarations?: Array<GeminiFunctionDeclaration>
}

interface GeminiFunctionDeclaration {
  name: string
  description?: string
  parameters?: Record<string, unknown>
}

interface GeminiToolConfig {
  functionCallingConfig?: {
    mode?: "AUTO" | "ANY" | "NONE"
    allowedFunctionNames?: Array<string>
  }
}

interface GeminiSafetySetting {
  category: GeminiHarmCategory
  threshold: GeminiHarmBlockThreshold
}

type GeminiHarmCategory =
  | "HARM_CATEGORY_HARASSMENT"
  | "HARM_CATEGORY_HATE_SPEECH"
  | "HARM_CATEGORY_SEXUALLY_EXPLICIT"
  | "HARM_CATEGORY_DANGEROUS_CONTENT"

type GeminiHarmBlockThreshold =
  | "BLOCK_NONE"
  | "BLOCK_LOW_AND_ABOVE"
  | "BLOCK_MEDIUM_AND_ABOVE"
  | "BLOCK_ONLY_HIGH"

// Response types

export interface GeminiGenerateContentResponse {
  candidates?: Array<GeminiCandidate>
  usageMetadata?: GeminiUsageMetadata
  modelVersion?: string
  promptFeedback?: GeminiPromptFeedback
}

export interface GeminiCandidate {
  content: GeminiContent
  finishReason?: GeminiFinishReason
  safetyRatings?: Array<GeminiSafetyRating>
  citationMetadata?: GeminiCitationMetadata
  index?: number
}

export type GeminiFinishReason =
  | "STOP"
  | "MAX_TOKENS"
  | "SAFETY"
  | "RECITATION"
  | "OTHER"
  | "FINISH_REASON_UNSPECIFIED"

interface GeminiSafetyRating {
  category: GeminiHarmCategory
  probability: "NEGLIGIBLE" | "LOW" | "MEDIUM" | "HIGH"
  blocked?: boolean
}

interface GeminiCitationMetadata {
  citations?: Array<GeminiCitation>
}

interface GeminiCitation {
  startIndex?: number
  endIndex?: number
  uri?: string
  title?: string
  license?: string
  publicationDate?: {
    year: number
    month: number
    day: number
  }
}

export interface GeminiUsageMetadata {
  promptTokenCount: number
  candidatesTokenCount?: number
  totalTokenCount: number
  cachedContentTokenCount?: number
}

interface GeminiPromptFeedback {
  blockReason?: "SAFETY" | "OTHER" | "BLOCK_REASON_UNSPECIFIED"
  safetyRatings?: Array<GeminiSafetyRating>
}

// Streaming types

export interface GeminiStreamChunk {
  candidates?: Array<GeminiCandidate>
  usageMetadata?: GeminiUsageMetadata
  modelVersion?: string
}

// Stream state for translation
export interface GeminiStreamState {
  model: string
  contentStarted: boolean
  accumulatedText: string
  finishReason?: GeminiFinishReason
  usage?: GeminiUsageMetadata
}
