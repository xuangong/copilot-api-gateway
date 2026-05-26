import { recordUsage } from "~/lib/usage-tracker"
import { touchApiKeyLastUsed } from "~/lib/api-keys"
import { createFrameBuffer, parseDataJSON } from "~/lib/sse/parser"
import { normalizeAnthropicVersion } from "~/services/copilot/variants"

interface UsageInfo {
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
}

interface UsageRecordInfo extends UsageInfo {
  model?: string
}

/**
 * Normalize a model id to the raw Copilot form so usage rows aggregate
 * correctly. Only transform: Anthropic dash version → Copilot dot version
 * (`claude-opus-4-7` → `claude-opus-4.7`). Anthropic SDK clients send the
 * dash form in payload.model, while upstream JSON echoes back the dot form;
 * without this, a single logical model splits across two usage rows.
 *
 * Everything else (effort/context/-internal suffixes) is preserved verbatim
 * — Copilot's raw id grammar (name[-effort][-context][-internal]) is itself
 * meaningful and matches what /v1/models exposes.
 */
function normalizeUsageModelId(id: string | undefined): string | undefined {
  if (!id) return id
  return normalizeAnthropicVersion(id)
}

/**
 * Pick the most specific model id for usage records.
 *
 * The caller-supplied `model` is `payload.model` AFTER provider-side variant
 * rewrite — it's the raw Copilot id we actually called upstream with
 * (e.g. `claude-opus-4.7-1m-internal`). Upstream JSON echoes back a less
 * specific form (the base id without the variant suffix), which would
 * silently collapse 1M / xhigh / etc. usage into the base model row. Prefer
 * the caller value; fall back to the JSON only when the caller didn't pass
 * one.
 */
function pickUsageModelId(
  fromJson: string | undefined,
  fromCaller: string,
): string {
  return normalizeUsageModelId(fromCaller) ?? fromJson ?? fromCaller
}

// deno-lint-ignore no-explicit-any
function modelFromJson(json: any): string | undefined {
  const model = json?.model ?? json?.message?.model ?? json?.response?.model
  const raw = typeof model === "string" && model.length > 0 ? model : undefined
  return normalizeUsageModelId(raw)
}

// deno-lint-ignore no-explicit-any
function extractUsageFromJson(json: any): UsageRecordInfo | null {
  // Anthropic Messages — gated on cache_read_input_tokens presence to disambiguate
  // from /v1/responses which also uses input_tokens
  if (json?.usage?.input_tokens != null && (json?.usage?.cache_read_input_tokens !== undefined || json?.usage?.cache_creation_input_tokens !== undefined)) {
    return {
      model: modelFromJson(json),
      input: json.usage.input_tokens,
      output: json.usage.output_tokens ?? 0,
      cacheRead: json.usage.cache_read_input_tokens ?? 0,
      cacheCreation: json.usage.cache_creation_input_tokens ?? 0,
    }
  }
  // Responses /v1/responses
  if (json?.usage?.input_tokens != null) {
    const cached = json.usage.input_tokens_details?.cached_tokens ?? 0
    return {
      model: modelFromJson(json),
      input: Math.max(0, json.usage.input_tokens - cached),
      output: json.usage.output_tokens ?? 0,
      cacheRead: cached,
      cacheCreation: 0,
    }
  }
  // OpenAI Chat Completions: { usage: { prompt_tokens, completion_tokens } }
  if (json?.usage?.prompt_tokens != null) {
    const cached = json.usage.prompt_tokens_details?.cached_tokens ?? 0
    return {
      model: modelFromJson(json),
      input: Math.max(0, json.usage.prompt_tokens - cached),
      output: json.usage.completion_tokens ?? 0,
      cacheRead: cached,
      cacheCreation: 0,
    }
  }
  return null
}

// deno-lint-ignore no-explicit-any
function applyStreamEvent(parsed: any, latest: UsageRecordInfo): boolean {
  const eventModel = modelFromJson(parsed)
  if (eventModel) latest.model = eventModel

  // Returns true when the event is a terminal usage frame (Responses
  // response.completed / response.incomplete, or OpenAI chat-completions
  // end-frame). Anthropic message_delta is cumulative — not terminal here,
  // because more deltas can still follow.
  if (parsed.type === "message_start" && parsed.message?.usage?.input_tokens != null) {
    const u = parsed.message.usage
    latest.input = u.input_tokens
    if (u.cache_read_input_tokens != null) latest.cacheRead = u.cache_read_input_tokens
    if (u.cache_creation_input_tokens != null) latest.cacheCreation = u.cache_creation_input_tokens
    return false
  } else if (parsed.type === "message_delta" && parsed.usage?.output_tokens != null) {
    const u = parsed.usage
    latest.output = u.output_tokens
    if (u.cache_read_input_tokens != null) latest.cacheRead = u.cache_read_input_tokens
    if (u.cache_creation_input_tokens != null) latest.cacheCreation = u.cache_creation_input_tokens
    return false
  } else if ((parsed.type === "response.completed" || parsed.type === "response.incomplete") && parsed.response?.usage) {
    const u = parsed.response.usage
    const cached = u.input_tokens_details?.cached_tokens ?? 0
    latest.input = Math.max(0, (u.input_tokens ?? 0) - cached)
    latest.output = u.output_tokens ?? 0
    latest.cacheRead = cached
    latest.cacheCreation = 0
    return true
  } else if (parsed.usage?.prompt_tokens != null) {
    const cached = parsed.usage.prompt_tokens_details?.cached_tokens ?? 0
    latest.input = Math.max(0, parsed.usage.prompt_tokens - cached)
    latest.output = parsed.usage.completion_tokens ?? 0
    latest.cacheRead = cached
    latest.cacheCreation = 0
    return true
  }
  return false
}

async function persistUsage(keyId: string, model: string, inputTokens: number, outputTokens: number, client?: string, cacheReadTokens?: number, cacheCreationTokens?: number, upstream?: string | null): Promise<void> {
  await Promise.all([
    recordUsage(keyId, model, inputTokens, outputTokens, client, cacheReadTokens, cacheCreationTokens, upstream),
    touchApiKeyLastUsed(keyId),
  ])
}

/**
 * Track usage from an already-parsed JSON response body.
 * Must be awaited before returning the Response to the client.
 */
export async function trackNonStreamingUsage(
  // deno-lint-ignore no-explicit-any
  json: any,
  keyId: string,
  model: string,
  client?: string,
  upstream?: string | null,
): Promise<void> {
  const usage = extractUsageFromJson(json)
  if (usage) {
    await persistUsage(keyId, pickUsageModelId(usage.model, model), usage.input, usage.output, client, usage.cacheRead, usage.cacheCreation, upstream)
  }
}

/**
 * Wrap a streaming response body with a TransformStream that extracts
 * usage data from SSE events without modifying the stream content.
 * Returns a new Response with the wrapped body.
 */
export function trackStreamingUsage(
  response: Response,
  keyId: string,
  model: string,
  client?: string,
  upstream?: string | null,
): Response {
  const body = response.body
  if (!body) return response

  const latest: UsageRecordInfo = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }
  const frameBuffer = createFrameBuffer()
  let persisted = false
  // Hold the D1 write promise so the outer async fn can await it before
  // resolving. On Cloudflare Workers, only promises observed by waitUntil
  // (transitively, via the promise this function returns) are guaranteed
  // to run to completion after the Response has been returned to the
  // client. A bare `persistUsage(...).catch(() => {})` is fire-and-forget:
  // the outer promise resolves at `consume-end`, waitUntil considers the
  // job done, and the in-flight D1 write gets killed mid-flight — which
  // is exactly why CFW silently dropped streaming usage while SSH did not.
  let persistPromise: Promise<void> | null = null
  const persistOnce = () => {
    if (persisted) return
    if (latest.input <= 0 && latest.output <= 0) return
    persisted = true
    persistPromise = persistUsage(keyId, pickUsageModelId(latest.model, model), latest.input, latest.output, client, latest.cacheRead, latest.cacheCreation, upstream).catch(() => {})
  }

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk)

      for (const frame of frameBuffer.push(chunk)) {
        if (frame.data === "[DONE]") continue
        const parsed = parseDataJSON<any>(frame)
        if (parsed && applyStreamEvent(parsed, latest)) {
          // Terminal usage frame seen — persist immediately so that a
          // downstream cancel before flush() does not lose the write.
          persistOnce()
        }
      }
    },
    async flush() {
      const tail = frameBuffer.flush()
      if (tail && tail.data && tail.data !== "[DONE]") {
        const parsed = parseDataJSON<any>(tail)
        if (parsed) applyStreamEvent(parsed, latest)
      }
      persistOnce()
      // Required on CFW — see note on `persistPromise` above.
      if (persistPromise) await persistPromise
    },
  })

  return new Response(body.pipeThrough(transform), {
    status: response.status,
    headers: response.headers,
  })
}

/**
 * Consume a raw upstream SSE ReadableStream purely for usage extraction,
 * without producing a Response. Use this on a `tee()`'d branch when the
 * downstream body is being transformed and would otherwise swallow usage frames.
 */
export function consumeStreamForUsage(
  upstreamBody: ReadableStream<Uint8Array>,
  keyId: string,
  model: string,
  client?: string,
  upstream?: string | null,
): Promise<void> {
  const latest: UsageRecordInfo = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }
  const frameBuffer = createFrameBuffer()
  let persisted = false
  // See `trackStreamingUsage` above — same CFW waitUntil hazard. The
  // promise returned by this function is what direct.ts hands to
  // `ctx.executionCtx.waitUntil(...)`. If we don't await the D1 write
  // here, the outer fn resolves as soon as the upstream reader hits EOF,
  // waitUntil treats us as done, and the persistUsage write is silently
  // truncated when the isolate is torn down.
  let persistPromise: Promise<void> | null = null
  const persistOnce = () => {
    if (persisted) return
    if (latest.input <= 0 && latest.output <= 0) return
    persisted = true
    persistPromise = persistUsage(
      keyId, pickUsageModelId(latest.model, model), latest.input, latest.output, client,
      latest.cacheRead, latest.cacheCreation, upstream,
    ).catch(() => {})
  }

  const reader = upstreamBody.getReader()
  return (async () => {
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        for (const frame of frameBuffer.push(value)) {
          if (frame.data === "[DONE]") continue
          const parsed = parseDataJSON<any>(frame)
          if (parsed && applyStreamEvent(parsed, latest)) {
            persistOnce()
          }
        }
      }
      const tail = frameBuffer.flush()
      if (tail && tail.data && tail.data !== "[DONE]") {
        const parsed = parseDataJSON<any>(tail)
        if (parsed) applyStreamEvent(parsed, latest)
      }
      persistOnce()
      // Critical on CFW — see note on `persistPromise` above.
      if (persistPromise) await persistPromise
    } catch { /* best-effort */ }
  })()
}
