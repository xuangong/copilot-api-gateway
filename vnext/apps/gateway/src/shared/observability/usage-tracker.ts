/**
 * Usage tracker — three entrypoints:
 *   - trackNonStreamingUsage: await-able writer for JSON bodies.
 *   - trackStreamingUsage: wraps a Response with a passthrough TransformStream
 *     that extracts usage frames and persists fire-and-forget at the first
 *     terminal frame (or at flush() for Anthropic deltas).
 *   - consumeStreamForUsage: drains an upstream body purely for usage; the
 *     returned promise settles AFTER the persist write completes.
 */
import type { ModelPricing } from '@vnext/protocols/common'
import { getRepo } from '../repo/index.ts'
import type { TokenUsage, UsageRecord } from '../repo/types.ts'
import { extractFromJson, applyStreamEvent, pickUsageModelId, type UsageInfo } from './usage-extractor.ts'
import { createFrameBuffer, parseDataJSON } from '../lib/sse/parser.ts'

function currentHour(): string {
  return new Date().toISOString().slice(0, 13)
}

function hasAnyTokens(usage: TokenUsage): boolean {
  for (const value of Object.values(usage)) {
    if ((value ?? 0) > 0) return true
  }
  return false
}

async function persistUsage(
  usage: TokenUsage,
  keyId: string,
  model: string,
  client: string,
  upstream: string | null,
  modelKey: string,
  pricing: ModelPricing | null,
): Promise<void> {
  if (!hasAnyTokens(usage)) return
  const rec: UsageRecord = {
    keyId,
    model,
    modelKey,
    upstream,
    client,
    hour: currentHour(),
    requests: 1,
    tokens: usage,
    cost: pricing,
  }
  const repo = getRepo()
  await Promise.all([
    repo.usage.record(rec),
    repo.apiKeys.touchLastUsed(keyId),
  ])
}

export async function trackNonStreamingUsage(
  json: unknown,
  keyId: string,
  model: string,
  client: string,
  upstream: string | null,
  modelKey: string,
  pricing: ModelPricing | null,
): Promise<void> {
  const info = extractFromJson(json)
  if (!info) return
  await persistUsage(
    info.tokens,
    keyId,
    pickUsageModelId(info.model, model),
    client,
    upstream,
    modelKey,
    pricing,
  )
}

export function trackStreamingUsage(
  response: Response,
  keyId: string,
  model: string,
  client: string,
  upstream: string | null,
  modelKey: string,
  pricing: ModelPricing | null,
): Response {
  const body = response.body
  if (!body) return response

  const latest: UsageInfo = { tokens: {} }
  const frameBuffer = createFrameBuffer()
  let persisted = false
  const persistOnce = () => {
    if (persisted) return
    if (!hasAnyTokens(latest.tokens)) return
    persisted = true
    persistUsage(
      latest.tokens,
      keyId,
      pickUsageModelId(latest.model, model),
      client,
      upstream,
      modelKey,
      pricing,
    ).catch(() => { /* fire-and-forget */ })
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
  client: string,
  upstream: string | null,
  modelKey: string,
  pricing: ModelPricing | null,
): Promise<void> {
  const latest: UsageInfo = { tokens: {} }
  const frameBuffer = createFrameBuffer()
  let persisted = false
  let persistPromise: Promise<void> | null = null
  const persistOnce = () => {
    if (persisted) return
    if (!hasAnyTokens(latest.tokens)) return
    persisted = true
    persistPromise = persistUsage(
      latest.tokens,
      keyId,
      pickUsageModelId(latest.model, model),
      client,
      upstream,
      modelKey,
      pricing,
    ).catch(() => { /* best-effort */ })
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
