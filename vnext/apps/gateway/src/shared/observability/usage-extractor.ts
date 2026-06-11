/**
 * Pure usage parsers for JSON bodies and SSE event frames.
 *
 * Three response shapes are recognized:
 *   1. Anthropic Messages — gated on `cache_read_input_tokens` /
 *      `cache_creation_input_tokens` to disambiguate from Responses.
 *   2. /v1/responses — input_tokens + input_tokens_details.cached_tokens.
 *   3. OpenAI Chat Completions — prompt_tokens + prompt_tokens_details.cached_tokens.
 *
 * Stream events are folded into a `latest` accumulator; only Responses
 * `response.completed` / `response.incomplete` and OpenAI Chat end-frames
 * are terminal (returning `true`). Anthropic `message_start` and
 * `message_delta` are NOT terminal — more deltas can still follow.
 */
import { copilotPublicModelId, normalizeAnthropicVersion } from '@vnext/provider-copilot'

export interface UsageInfo {
  model?: string
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
}

function normalizeUsageModelId(id: string | undefined): string | undefined {
  if (!id) return id
  return normalizeAnthropicVersion(id)
}

function modelFromJson(json: unknown): string | undefined {
  const j = json as { model?: unknown; message?: { model?: unknown }; response?: { model?: unknown } } | null
  const candidate = j?.model ?? j?.message?.model ?? j?.response?.model
  const raw = typeof candidate === 'string' && candidate.length > 0 ? candidate : undefined
  return normalizeUsageModelId(raw)
}

/**
 * Pick the most specific id between caller-provided and JSON-extracted.
 * Caller wins only when (a) both refer to the same Copilot logical model,
 * and (b) caller carries a strictly longer variant suffix.
 */
export function pickUsageModelId(
  fromJson: string | undefined,
  fromCaller: string,
): string {
  const normalizedCaller = normalizeUsageModelId(fromCaller)
  if (!fromJson) return normalizedCaller ?? fromCaller
  if (!normalizedCaller) return fromJson
  if (normalizedCaller === fromJson) return fromJson
  const sameBase = copilotPublicModelId(normalizedCaller) === copilotPublicModelId(fromJson)
  if (sameBase && normalizedCaller.length > fromJson.length) return normalizedCaller
  return fromJson
}

export function extractFromJson(json: unknown): UsageInfo | null {
  const j = json as {
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_read_input_tokens?: number
      cache_creation_input_tokens?: number
      input_tokens_details?: { cached_tokens?: number }
      prompt_tokens?: number
      completion_tokens?: number
      prompt_tokens_details?: { cached_tokens?: number }
    }
  } | null
  const u = j?.usage
  if (!u) return null

  if (u.input_tokens != null && (u.cache_read_input_tokens !== undefined || u.cache_creation_input_tokens !== undefined)) {
    return {
      model: modelFromJson(json),
      input: u.input_tokens,
      output: u.output_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0,
      cacheCreation: u.cache_creation_input_tokens ?? 0,
    }
  }
  if (u.input_tokens != null) {
    const cached = u.input_tokens_details?.cached_tokens ?? 0
    return {
      model: modelFromJson(json),
      input: Math.max(0, u.input_tokens - cached),
      output: u.output_tokens ?? 0,
      cacheRead: cached,
      cacheCreation: 0,
    }
  }
  if (u.prompt_tokens != null) {
    const cached = u.prompt_tokens_details?.cached_tokens ?? 0
    return {
      model: modelFromJson(json),
      input: Math.max(0, u.prompt_tokens - cached),
      output: u.completion_tokens ?? 0,
      cacheRead: cached,
      cacheCreation: 0,
    }
  }
  return null
}

/**
 * Fold an SSE event into the running usage accumulator.
 * Returns `true` on terminal frames (Responses completed/incomplete,
 * OpenAI Chat end-frame). Anthropic message_start / message_delta are
 * cumulative and NOT terminal.
 */
export function applyStreamEvent(parsed: unknown, latest: UsageInfo): boolean {
  const p = parsed as {
    type?: string
    message?: { model?: string; usage?: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } }
    response?: { model?: string; usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } } }
    usage?: { output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } }
    model?: string
  }

  const eventModel = modelFromJson(parsed)
  if (eventModel) latest.model = eventModel

  if (p.type === 'message_start' && p.message?.usage?.input_tokens != null) {
    const u = p.message.usage
    latest.input = u.input_tokens ?? 0
    if (u.cache_read_input_tokens != null) latest.cacheRead = u.cache_read_input_tokens
    if (u.cache_creation_input_tokens != null) latest.cacheCreation = u.cache_creation_input_tokens
    return false
  }
  if (p.type === 'message_delta' && p.usage?.output_tokens != null) {
    const u = p.usage
    latest.output = u.output_tokens ?? 0
    if (u.cache_read_input_tokens != null) latest.cacheRead = u.cache_read_input_tokens
    if (u.cache_creation_input_tokens != null) latest.cacheCreation = u.cache_creation_input_tokens
    return false
  }
  if ((p.type === 'response.completed' || p.type === 'response.incomplete') && p.response?.usage) {
    const u = p.response.usage
    const cached = u.input_tokens_details?.cached_tokens ?? 0
    latest.input = Math.max(0, (u.input_tokens ?? 0) - cached)
    latest.output = u.output_tokens ?? 0
    latest.cacheRead = cached
    latest.cacheCreation = 0
    return true
  }
  if (p.usage?.prompt_tokens != null) {
    const cached = p.usage.prompt_tokens_details?.cached_tokens ?? 0
    latest.input = Math.max(0, p.usage.prompt_tokens - cached)
    latest.output = p.usage.completion_tokens ?? 0
    latest.cacheRead = cached
    latest.cacheCreation = 0
    return true
  }
  return false
}
