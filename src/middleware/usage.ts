import { recordUsage } from "~/lib/usage-tracker"
import { touchApiKeyLastUsed } from "~/lib/api-keys"

interface UsageInfo {
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
}

// deno-lint-ignore no-explicit-any
function extractUsageFromJson(json: any): UsageInfo | null {
  // Anthropic Messages — gated on cache_read_input_tokens presence to disambiguate
  // from /v1/responses which also uses input_tokens
  if (json?.usage?.input_tokens != null && (json?.usage?.cache_read_input_tokens !== undefined || json?.usage?.cache_creation_input_tokens !== undefined)) {
    return {
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
      input: Math.max(0, json.usage.prompt_tokens - cached),
      output: json.usage.completion_tokens ?? 0,
      cacheRead: cached,
      cacheCreation: 0,
    }
  }
  return null
}

// deno-lint-ignore no-explicit-any
function applyStreamEvent(parsed: any, latest: UsageInfo): void {
  // Anthropic message_start: sets cumulative input + cache tokens
  if (parsed.type === "message_start" && parsed.message?.usage?.input_tokens != null) {
    const u = parsed.message.usage
    latest.input = u.input_tokens
    latest.cacheRead = u.cache_read_input_tokens ?? 0
    latest.cacheCreation = u.cache_creation_input_tokens ?? 0
  // Anthropic message_delta: each event carries the CUMULATIVE output_tokens so far (overwrite, not add)
  // Newer Anthropic API versions also include cache tokens in message_delta
  } else if (parsed.type === "message_delta" && parsed.usage?.output_tokens != null) {
    const u = parsed.usage
    latest.output = u.output_tokens
    if (u.cache_read_input_tokens != null) latest.cacheRead = u.cache_read_input_tokens
    if (u.cache_creation_input_tokens != null) latest.cacheCreation = u.cache_creation_input_tokens
  // Responses response.completed: terminal frame — overwrite with final values
  } else if (parsed.type === "response.completed" && parsed.response?.usage) {
    const u = parsed.response.usage
    const cached = u.input_tokens_details?.cached_tokens ?? 0
    latest.input = Math.max(0, (u.input_tokens ?? 0) - cached)
    latest.output = u.output_tokens ?? 0
    latest.cacheRead = cached
    latest.cacheCreation = 0
  // OpenAI Chat Completions chunk with usage — terminal end-frame, overwrite
  } else if (parsed.usage?.prompt_tokens != null) {
    const cached = parsed.usage.prompt_tokens_details?.cached_tokens ?? 0
    latest.input = Math.max(0, parsed.usage.prompt_tokens - cached)
    latest.output = parsed.usage.completion_tokens ?? 0
    latest.cacheRead = cached
    latest.cacheCreation = 0
  }
}

async function persistUsage(keyId: string, model: string, inputTokens: number, outputTokens: number, client?: string, cacheReadTokens?: number, cacheCreationTokens?: number): Promise<void> {
  await Promise.all([
    recordUsage(keyId, model, inputTokens, outputTokens, client, cacheReadTokens, cacheCreationTokens),
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
): Promise<void> {
  const usage = extractUsageFromJson(json)
  if (usage) {
    await persistUsage(keyId, model, usage.input, usage.output, client, usage.cacheRead, usage.cacheCreation)
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
): Response {
  const body = response.body
  if (!body) return response

  const latest: UsageInfo = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }
  let buffer = ""

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk)

      buffer += new TextDecoder().decode(chunk)
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue
        const data = line.slice(6).trim()
        if (!data || data === "[DONE]") continue

        try {
          const parsed = JSON.parse(data)
          applyStreamEvent(parsed, latest)
        } catch { /* ignore non-JSON lines */ }
      }
    },
    async flush() {
      if (buffer.startsWith("data: ")) {
        const data = buffer.slice(6).trim()
        if (data && data !== "[DONE]") {
          try {
            const parsed = JSON.parse(data)
            applyStreamEvent(parsed, latest)
          } catch { /* ignore */ }
        }
      }

      if (latest.input > 0 || latest.output > 0) {
        await persistUsage(keyId, model, latest.input, latest.output, client, latest.cacheRead, latest.cacheCreation).catch(() => {})
      }
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
): void {
  const latest: UsageInfo = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }
  const decoder = new TextDecoder("utf-8")
  let buffer = ""

  const reader = upstreamBody.getReader()
  ;(async () => {
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split("\n")
        buffer = lines.pop() ?? ""
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue
          const data = line.slice(6).trim()
          if (!data || data === "[DONE]") continue
          try { applyStreamEvent(JSON.parse(data), latest) } catch { /* ignore */ }
        }
      }
      // flush remaining buffer
      buffer += decoder.decode()
      if (buffer.startsWith("data: ")) {
        const data = buffer.slice(6).trim()
        if (data && data !== "[DONE]") {
          try { applyStreamEvent(JSON.parse(data), latest) } catch { /* ignore */ }
        }
      }
      if (latest.input > 0 || latest.output > 0) {
        await persistUsage(
          keyId, model, latest.input, latest.output, client,
          latest.cacheRead, latest.cacheCreation,
        ).catch(() => {})
      }
    } catch { /* best-effort */ }
  })()
}
