/**
 * Pure usage parsers for JSON bodies and SSE event frames.
 *
 * Three response shapes are recognized:
 *   1. Anthropic Messages — gated on `cache_read_input_tokens` /
 *      `cache_creation_input_tokens` to disambiguate from Responses.
 *   2. /v1/responses — input_tokens + input_tokens_details.cached_tokens.
 *      When *_tokens_details carries text/image splits, the image-modality
 *      split is preserved via `tokenUsageFromImagesResponse`.
 *   3. OpenAI Chat Completions — prompt_tokens + prompt_tokens_details.cached_tokens.
 *
 * Stream events are folded into a `latest` accumulator; only Responses
 * `response.completed` / `response.incomplete` and OpenAI Chat end-frames
 * are terminal (returning `true`). Anthropic `message_start` and
 * `message_delta` are NOT terminal — more deltas can still follow.
 */
import { copilotPublicModelId, normalizeAnthropicVersion } from '@vnext/provider-copilot'
import { BILLING_DIMENSIONS, type BillingDimension } from '@vnext-llm/protocols/common'
import type { TokenUsage } from '../repo/types.ts'

export interface UsageInfo {
  model?: string
  tokens: TokenUsage
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

// Drop zero / undefined dimensions so a usage map only carries the dimensions
// actually billed.
function compactTokens(counts: TokenUsage): TokenUsage {
  const out: TokenUsage = {}
  for (const dimension of BILLING_DIMENSIONS) {
    const value = counts[dimension] ?? 0
    if (value > 0) out[dimension] = value
  }
  return out
}

interface ImagesUsageShape {
  input_tokens?: unknown
  output_tokens?: unknown
  input_tokens_details?: unknown
  output_tokens_details?: unknown
}

function splitModalityCounts(
  textDimension: BillingDimension,
  imageDimension: BillingDimension,
  total: number | undefined,
  details: unknown,
): TokenUsage | null {
  if (total === undefined) return {}
  if (details === undefined) return { [textDimension]: total }
  if (!details || typeof details !== 'object') return null
  const { text_tokens: text, image_tokens: image } = details as { text_tokens?: unknown; image_tokens?: unknown }
  if (text !== undefined && typeof text !== 'number') return null
  if (image !== undefined && typeof image !== 'number') return null
  // A details object that carries neither split is as good as absent.
  if (text === undefined && image === undefined) return { [textDimension]: total }
  return { [textDimension]: text ?? 0, [imageDimension]: image ?? 0 }
}

/**
 * OpenAI Images / Responses usage shape:
 *   `{input_tokens, output_tokens, total_tokens, input_tokens_details, output_tokens_details}`
 * where details split each total into `text_tokens` and `image_tokens`. We map
 * the split onto billing dimensions: bare input/output for text, *_image for
 * image. When a details object is missing but its total is present, the whole
 * total is charged on the bare dimension. A present non-number field is
 * treated as a malformed upstream payload (return null).
 */
export function tokenUsageFromImagesResponse(usage: unknown): TokenUsage | null {
  if (!usage || typeof usage !== 'object') return null
  const { input_tokens: inputTotal, output_tokens: outputTotal, input_tokens_details: inputDetails, output_tokens_details: outputDetails } = usage as ImagesUsageShape

  if (inputTotal !== undefined && typeof inputTotal !== 'number') return null
  if (outputTotal !== undefined && typeof outputTotal !== 'number') return null
  if (inputTotal === undefined && outputTotal === undefined) return null

  const input = splitModalityCounts('input', 'input_image', inputTotal as number | undefined, inputDetails)
  if (input === null) return null
  const output = splitModalityCounts('output', 'output_image', outputTotal as number | undefined, outputDetails)
  if (output === null) return null

  return compactTokens({ ...input, ...output })
}

export function extractFromJson(json: unknown): UsageInfo | null {
  const j = json as {
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_read_input_tokens?: number
      cache_creation_input_tokens?: number
      input_tokens_details?: { cached_tokens?: number; text_tokens?: number; image_tokens?: number }
      output_tokens_details?: { text_tokens?: number; image_tokens?: number }
      prompt_tokens?: number
      completion_tokens?: number
      prompt_tokens_details?: { cached_tokens?: number; cache_creation_input_tokens?: number }
    }
  } | null
  const u = j?.usage
  if (!u) return null

  if (u.input_tokens != null && (u.cache_read_input_tokens !== undefined || u.cache_creation_input_tokens !== undefined)) {
    return {
      model: modelFromJson(json),
      tokens: compactTokens({
        input: u.input_tokens,
        output: u.output_tokens ?? 0,
        input_cache_read: u.cache_read_input_tokens ?? 0,
        input_cache_write: u.cache_creation_input_tokens ?? 0,
      }),
    }
  }
  if (u.input_tokens != null) {
    const hasModalitySplit = hasImageModalityDetails(u.input_tokens_details) || hasImageModalityDetails(u.output_tokens_details)
    if (hasModalitySplit) {
      const images = tokenUsageFromImagesResponse(u)
      if (images) {
        return { model: modelFromJson(json), tokens: images }
      }
    }
    const cached = u.input_tokens_details?.cached_tokens ?? 0
    return {
      model: modelFromJson(json),
      tokens: compactTokens({
        input: Math.max(0, u.input_tokens - cached),
        output: u.output_tokens ?? 0,
        input_cache_read: cached,
      }),
    }
  }
  if (u.prompt_tokens != null) {
    const cached = u.prompt_tokens_details?.cached_tokens ?? 0
    const cacheWrite = u.prompt_tokens_details?.cache_creation_input_tokens ?? 0
    return {
      model: modelFromJson(json),
      tokens: compactTokens({
        input: Math.max(0, u.prompt_tokens - cached - cacheWrite),
        output: u.completion_tokens ?? 0,
        input_cache_read: cached,
        input_cache_write: cacheWrite,
      }),
    }
  }
  return null
}

function hasImageModalityDetails(details: unknown): boolean {
  if (!details || typeof details !== 'object') return false
  const d = details as { text_tokens?: unknown; image_tokens?: unknown }
  return d.text_tokens !== undefined || d.image_tokens !== undefined
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
    response?: {
      model?: string
      usage?: {
        input_tokens?: number
        output_tokens?: number
        input_tokens_details?: { cached_tokens?: number; text_tokens?: number; image_tokens?: number }
        output_tokens_details?: { text_tokens?: number; image_tokens?: number }
      }
    }
    usage?: {
      output_tokens?: number
      cache_read_input_tokens?: number
      cache_creation_input_tokens?: number
      prompt_tokens?: number
      completion_tokens?: number
      prompt_tokens_details?: { cached_tokens?: number; cache_creation_input_tokens?: number }
    }
    model?: string
  }

  const eventModel = modelFromJson(parsed)
  if (eventModel) latest.model = eventModel

  if (p.type === 'message_start' && p.message?.usage?.input_tokens != null) {
    const u = p.message.usage
    const next: TokenUsage = {
      input: u.input_tokens ?? 0,
      output: latest.tokens.output ?? 0,
    }
    next.input_cache_read = u.cache_read_input_tokens ?? latest.tokens.input_cache_read ?? 0
    next.input_cache_write = u.cache_creation_input_tokens ?? latest.tokens.input_cache_write ?? 0
    latest.tokens = compactTokens(next)
    return false
  }
  if (p.type === 'message_delta' && p.usage?.output_tokens != null) {
    const u = p.usage
    const next: TokenUsage = {
      input: latest.tokens.input ?? 0,
      output: u.output_tokens ?? 0,
    }
    next.input_cache_read = u.cache_read_input_tokens ?? latest.tokens.input_cache_read ?? 0
    next.input_cache_write = u.cache_creation_input_tokens ?? latest.tokens.input_cache_write ?? 0
    latest.tokens = compactTokens(next)
    return false
  }
  if ((p.type === 'response.completed' || p.type === 'response.incomplete') && p.response?.usage) {
    const u = p.response.usage
    const hasModalitySplit = hasImageModalityDetails(u.input_tokens_details) || hasImageModalityDetails(u.output_tokens_details)
    if (hasModalitySplit) {
      const images = tokenUsageFromImagesResponse(u)
      if (images) {
        latest.tokens = images
        return true
      }
    }
    const cached = u.input_tokens_details?.cached_tokens ?? 0
    latest.tokens = compactTokens({
      input: Math.max(0, (u.input_tokens ?? 0) - cached),
      output: u.output_tokens ?? 0,
      input_cache_read: cached,
    })
    return true
  }
  // Gemini terminal frame — usage lives on a top-level `usageMetadata` object
  // (NOT under `usage`). Final frame of streamGenerateContent carries
  // {promptTokenCount, candidatesTokenCount, cachedContentTokenCount?,
  //  thoughtsTokenCount?, totalTokenCount?}. We mirror the responses-side
  // cache subtraction: `input` excludes cached read, which goes to
  // `input_cache_read`. Returns `true` because the gemini final frame IS the
  // terminator (there's no separate done sentinel on the gemini wire).
  // Placed above the OpenAI `prompt_tokens` fallthrough so gemini frames that
  // also happen to carry an `usage` object (rare proxy edge case) still
  // resolve to the source-specific extractor.
  const usageMetaCandidate = (parsed as { usageMetadata?: unknown }).usageMetadata
  if (usageMetaCandidate && typeof usageMetaCandidate === 'object') {
    const u = usageMetaCandidate as {
      promptTokenCount?: number
      candidatesTokenCount?: number
      cachedContentTokenCount?: number
    }
    if (u.promptTokenCount != null) {
      const cached = u.cachedContentTokenCount ?? 0
      latest.tokens = compactTokens({
        input: Math.max(0, u.promptTokenCount - cached),
        output: u.candidatesTokenCount ?? 0,
        input_cache_read: cached,
      })
      return true
    }
  }
  if (p.usage?.prompt_tokens != null) {
    const cached = p.usage.prompt_tokens_details?.cached_tokens ?? 0
    const cacheWrite = p.usage.prompt_tokens_details?.cache_creation_input_tokens ?? 0
    latest.tokens = compactTokens({
      input: Math.max(0, p.usage.prompt_tokens - cached - cacheWrite),
      output: p.usage.completion_tokens ?? 0,
      input_cache_read: cached,
      input_cache_write: cacheWrite,
    })
    return true
  }
  return false
}
