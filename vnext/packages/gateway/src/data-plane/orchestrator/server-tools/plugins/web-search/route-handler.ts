/**
 * Messages web-search route handler — Week 4b-3 port of
 * src/routes/messages/web-search.ts `handleWebSearch` + `buildWebSearchStreamingResponse`.
 *
 * Slimmed for vnext scope:
 *   - latency-tracker / trackNonStreamingUsage / detectClient: not yet ported
 *     (Week 6 observability bundle). Side-effects here are limited to
 *     `recordWebSearchUsage` until then.
 *   - raceWithHeartbeat / wrapAnthropicHeartbeat: dropped on non-streaming path
 *     (clients waiting for JSON tolerate longer waits than SSE clients); the
 *     streaming path still does its own synthetic message_start + 5s ping
 *     loop so SSE clients dodge first-byte timeouts.
 */
import type { CreateProviderOptions } from '../../../../providers/registry.ts'

import { addWebSearchHeaders, loadWebSearchConfig, recordWebSearchUsage } from './core.ts'
import { interceptWebSearch, type MessagesPayload, type MessagesInterceptedSearch } from './interceptor.ts'
import { replayResponseAsSSE } from './sse-replay.ts'
import type { ApiResponse, WebSearchMeta } from './types.ts'

export interface WebSearchRouteContext {
  /** Copilot upstream credentials packaged for the provider registry. */
  copilot: CreateProviderOptions
  githubToken: string
  msGroundingKey?: string
  apiKeyId?: string
  requestId?: string
  /** Forwarded to the inner messagesAttempt call so client-detect categorises the leaf calls. */
  userAgent?: string
}

/**
 * Run the Messages web-search intercept loop. Returns either the final
 * Anthropic-shaped response (non-streaming) or an SSE stream (streaming),
 * or a 400 Response when web search is not enabled for the key.
 */
export async function handleMessagesWebSearch(
  ctx: WebSearchRouteContext,
  messagesPayload: MessagesPayload,
): Promise<Response> {
  const cfg = await loadWebSearchConfig(ctx.apiKeyId, ctx.githubToken, ctx.msGroundingKey)
  if (!cfg.enabled || !cfg.engineOptions) {
    return cfg.errorResponse ?? new Response(
      JSON.stringify({
        error: {
          type: 'invalid_request_error',
          message: 'Web search is not enabled for this API key.',
        },
      }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    )
  }

  const wantsStream = messagesPayload.stream === true
  const interceptPayload: MessagesPayload = { ...messagesPayload, stream: false }

  const upstreamPromise = interceptWebSearch(interceptPayload, {
    copilot: ctx.copilot,
    engineOptions: cfg.engineOptions,
    apiKeyId: ctx.apiKeyId,
    userAgent: ctx.userAgent,
    requestId: ctx.requestId,
    model: messagesPayload.model,
  })

  if (wantsStream) {
    return buildWebSearchStreamingResponse(
      messagesPayload.model,
      upstreamPromise,
      ctx,
    )
  }

  const { response, meta } = await upstreamPromise
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  addWebSearchHeaders(headers, meta)
  recordWebSearchUsage(ctx.apiKeyId, meta)
  return new Response(JSON.stringify(response), { headers })
}

/**
 * Streaming client needs immediate bytes to dodge first-byte timeouts (e.g.
 * the PowerPoint Claude plugin closes after ~14s of silence). Open the SSE
 * stream with a synthetic message_start so the client sees a real protocol
 * event right away, ping periodically while the upstream web_search loop
 * runs, then append the replayed message frames once it resolves.
 */
function buildWebSearchStreamingResponse(
  model: string,
  upstreamPromise: Promise<{ response: unknown; meta: WebSearchMeta; searches: MessagesInterceptedSearch[] }>,
  ctx: WebSearchRouteContext,
): Response {
  const encoder = new TextEncoder()
  const PING = encoder.encode('event: ping\ndata: {}\n\n')
  const PING_INTERVAL_MS = 5000

  const synthMessageId = `msg_synth_${Date.now().toString(36)}`
  const synthStart = encoder.encode(
    `event: message_start\ndata: ${JSON.stringify({
      type: 'message_start',
      message: {
        id: synthMessageId,
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    })}\n\n`,
  )
  const headers: Record<string, string> = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  }
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try { controller.enqueue(synthStart) } catch { /* ignore */ }
      let closed = false
      const ping = setInterval(() => {
        if (closed) return
        try { controller.enqueue(PING) } catch { /* ignore */ }
      }, PING_INTERVAL_MS)
      const stopPing = () => { closed = true; clearInterval(ping) }

      try {
        const result = await upstreamPromise
        const { response, meta } = result
        console.log(JSON.stringify({
          evt: 'ws_stream_replay_start',
          rid: ctx.requestId,
          searchCount: meta.searchCount,
        }))
        for (const s of result.searches) {
          const frame =
            `event: web_search_progress\ndata: ${JSON.stringify({
              type: 'web_search_progress',
              item_id: s.toolUseId,
              status: 'completed',
              query: s.query,
              is_error: s.isError,
            })}\n\n`
          try { controller.enqueue(encoder.encode(frame)) } catch { /* ignore */ }
        }
        const sseBody = replayResponseAsSSE(response as ApiResponse, { skipMessageStart: true })
        const reader = sseBody.getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (value && value.length > 0) {
            try { controller.enqueue(value) } catch { break }
          }
        }
        recordWebSearchUsage(ctx.apiKeyId, meta)
        stopPing()
        try { controller.close() } catch { /* ignore */ }
      } catch (err) {
        stopPing()
        console.error('[ws-stream] upstream error', err)
        try {
          const msg = err instanceof Error ? err.message : String(err)
          const errFrame =
            `event: error\ndata: ${JSON.stringify({
              type: 'error',
              error: { type: 'api_error', message: msg },
            })}\n\n`
          controller.enqueue(encoder.encode(errFrame))
        } catch { /* ignore */ }
        try { controller.close() } catch { /* ignore */ }
      }
    },
  })
  return new Response(stream, { headers })
}
