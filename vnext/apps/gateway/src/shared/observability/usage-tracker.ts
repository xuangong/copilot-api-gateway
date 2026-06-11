/**
 * Usage tracker — three entrypoints:
 *   - trackNonStreamingUsage: await-able writer for JSON bodies.
 *   - trackStreamingUsage: wraps a Response with a passthrough TransformStream
 *     that extracts usage frames and persists fire-and-forget at the first
 *     terminal frame (or at flush() for Anthropic deltas).
 *   - consumeStreamForUsage: drains an upstream body purely for usage; the
 *     returned promise settles AFTER the persist write completes.
 */
import { getRepo } from '../repo/index.ts'
import { extractFromJson, applyStreamEvent, pickUsageModelId, type UsageInfo } from './usage-extractor.ts'
import { createFrameBuffer, parseDataJSON } from '../lib/sse/parser.ts'

function currentHour(): string {
  return new Date().toISOString().slice(0, 13)
}

async function persistUsage(
  keyId: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  client: string | undefined,
  cacheReadTokens: number,
  cacheCreationTokens: number,
  upstream: string | null | undefined,
): Promise<void> {
  const repo = getRepo()
  await Promise.all([
    repo.usage.record(keyId, model, currentHour(), 1, inputTokens, outputTokens, client, cacheReadTokens, cacheCreationTokens, upstream ?? null),
    repo.apiKeys.touchLastUsed(keyId),
  ])
}

export async function trackNonStreamingUsage(
  json: unknown,
  keyId: string,
  model: string,
  client?: string,
  upstream?: string | null,
): Promise<void> {
  const usage = extractFromJson(json)
  if (!usage) return
  await persistUsage(
    keyId,
    pickUsageModelId(usage.model, model),
    usage.input, usage.output,
    client,
    usage.cacheRead, usage.cacheCreation,
    upstream,
  )
}

export function trackStreamingUsage(
  response: Response,
  keyId: string,
  model: string,
  client?: string,
  upstream?: string | null,
): Response {
  const body = response.body
  if (!body) return response

  const latest: UsageInfo = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }
  const frameBuffer = createFrameBuffer()
  let persisted = false
  const persistOnce = () => {
    if (persisted) return
    if (latest.input <= 0 && latest.output <= 0) return
    persisted = true
    persistUsage(keyId, pickUsageModelId(latest.model, model), latest.input, latest.output, client, latest.cacheRead, latest.cacheCreation, upstream)
      .catch(() => { /* fire-and-forget */ })
  }

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk)
      for (const frame of frameBuffer.push(chunk)) {
        if (frame.data === '[DONE]') continue
        const parsed = parseDataJSON<unknown>(frame)
        if (parsed && applyStreamEvent(parsed, latest)) persistOnce()
      }
    },
    flush() {
      const tail = frameBuffer.flush()
      if (tail && tail.data && tail.data !== '[DONE]') {
        const parsed = parseDataJSON<unknown>(tail)
        if (parsed) applyStreamEvent(parsed, latest)
      }
      persistOnce()
    },
  })

  return new Response(body.pipeThrough(transform), {
    status: response.status,
    headers: response.headers,
  })
}

export function consumeStreamForUsage(
  upstreamBody: ReadableStream<Uint8Array>,
  keyId: string,
  model: string,
  client?: string,
  upstream?: string | null,
): Promise<void> {
  const latest: UsageInfo = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }
  const frameBuffer = createFrameBuffer()
  let persisted = false
  let persistPromise: Promise<void> | null = null
  const persistOnce = () => {
    if (persisted) return
    if (latest.input <= 0 && latest.output <= 0) return
    persisted = true
    persistPromise = persistUsage(keyId, pickUsageModelId(latest.model, model), latest.input, latest.output, client, latest.cacheRead, latest.cacheCreation, upstream)
      .catch(() => { /* best-effort */ })
  }

  const reader = upstreamBody.getReader()
  return (async () => {
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        for (const frame of frameBuffer.push(value!)) {
          if (frame.data === '[DONE]') continue
          const parsed = parseDataJSON<unknown>(frame)
          if (parsed && applyStreamEvent(parsed, latest)) persistOnce()
        }
      }
      const tail = frameBuffer.flush()
      if (tail && tail.data && tail.data !== '[DONE]') {
        const parsed = parseDataJSON<unknown>(tail)
        if (parsed) applyStreamEvent(parsed, latest)
      }
      persistOnce()
      if (persistPromise) await persistPromise
    } catch { /* best-effort */ }
  })()
}
