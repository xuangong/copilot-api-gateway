import { recordUsage } from "~/lib/usage-tracker"
import { touchApiKeyLastUsed } from "~/lib/api-keys"

interface UsageInfo {
  input: number
  output: number
}

// deno-lint-ignore no-explicit-any
function extractUsageFromJson(json: any): UsageInfo | null {
  // Anthropic Messages: { usage: { input_tokens, output_tokens } }
  if (json?.usage?.input_tokens != null) {
    return { input: json.usage.input_tokens, output: json.usage.output_tokens ?? 0 }
  }
  // OpenAI Chat Completions: { usage: { prompt_tokens, completion_tokens } }
  if (json?.usage?.prompt_tokens != null) {
    return { input: json.usage.prompt_tokens, output: json.usage.completion_tokens ?? 0 }
  }
  return null
}

// deno-lint-ignore no-explicit-any
function extractUsageFromStreamEvent(parsed: any, add: (input: number, output: number) => void): void {
  // Anthropic message_start: { message: { usage: { input_tokens } } }
  if (parsed.type === "message_start" && parsed.message?.usage?.input_tokens != null) {
    add(parsed.message.usage.input_tokens, 0)
  }
  // Anthropic message_delta: { usage: { output_tokens } }
  if (parsed.type === "message_delta" && parsed.usage?.output_tokens != null) {
    add(0, parsed.usage.output_tokens)
  }
  // Responses response.completed: { response: { usage: { input_tokens, output_tokens } } }
  if (parsed.type === "response.completed" && parsed.response?.usage) {
    const u = parsed.response.usage
    add(u.input_tokens ?? 0, u.output_tokens ?? 0)
  }
  // OpenAI Chat Completions chunk with usage
  if (parsed.usage?.prompt_tokens != null) {
    add(parsed.usage.prompt_tokens, parsed.usage.completion_tokens ?? 0)
  }
}

async function persistUsage(keyId: string, model: string, inputTokens: number, outputTokens: number, client?: string): Promise<void> {
  await Promise.all([
    recordUsage(keyId, model, inputTokens, outputTokens, client),
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
    await persistUsage(keyId, model, usage.input, usage.output, client)
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

  let inputTokens = 0
  let outputTokens = 0
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
          extractUsageFromStreamEvent(parsed, (i, o) => {
            inputTokens += i
            outputTokens += o
          })
        } catch { /* ignore non-JSON lines */ }
      }
    },
    async flush() {
      if (buffer.startsWith("data: ")) {
        const data = buffer.slice(6).trim()
        if (data && data !== "[DONE]") {
          try {
            const parsed = JSON.parse(data)
            extractUsageFromStreamEvent(parsed, (i, o) => {
              inputTokens += i
              outputTokens += o
            })
          } catch { /* ignore */ }
        }
      }

      if (inputTokens > 0 || outputTokens > 0) {
        await persistUsage(keyId, model, inputTokens, outputTokens, client).catch(() => {})
      }
    },
  })

  return new Response(body.pipeThrough(transform), {
    status: response.status,
    headers: response.headers,
  })
}
