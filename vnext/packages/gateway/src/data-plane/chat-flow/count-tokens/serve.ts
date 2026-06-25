// packages/gateway/src/data-plane/chat-flow/count-tokens/serve.ts
import type { DataPlaneAuthCtx } from '../../models/routes.ts'
import { parseMessagesCountTokensPayload } from '../../parsers.ts'
import { resolveBinding, stripUpstreamPin } from '../../routing/binding-resolver.ts'
import { repackageUpstreamError } from '../../errors/repackage.ts'
import { HTTPError } from '@vibe-llm/provider-copilot'
import { jsonErrorWrap } from '../shared/error-wrap.ts'

export interface CountTokensServeArgs {
  raw: unknown
  auth: DataPlaneAuthCtx
  forwardedHeaders: Record<string, string>
  signal?: AbortSignal
}

export async function serveCountTokens(args: CountTokensServeArgs): Promise<Response> {
  let payload
  try { payload = parseMessagesCountTokensPayload(args.raw) }
  catch (err) {
    const e = err as Error & { status?: number; body?: unknown }
    return jsonErrorWrap(
      e.status ?? 400,
      e.body ?? { type: 'error', error: { type: 'invalid_request_error', message: e.message } },
    )
  }
  stripUpstreamPin(payload as unknown as Record<string, unknown>)

  const binding = await resolveBinding(payload.model, 'messages_count_tokens', {
    ownerId: args.auth.userId,
    copilot: args.auth.copilot,
  })
  if (!binding) {
    return jsonErrorWrap(404, {
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: `No messages_count_tokens upstream available for model: ${payload.model}. Run GET /v1/models for available ids.`,
      },
    })
  }

  try {
    const headers = new Headers({ 'content-type': 'application/json' })
    for (const [k, v] of Object.entries(args.forwardedHeaders)) headers.set(k, v)
    const pr = await binding.provider.fetch({
      endpoint: 'messages_count_tokens',
      payload,
      headers,
      sourceApi: 'anthropic',
      operationName: 'count tokens',
      flags: { isStreaming: false },
      signal: args.signal,
    })
    const response = new Response(pr.body, { status: pr.status, headers: pr.headers })
    const json = await response.json()
    return Response.json(json, { status: response.status })
  } catch (err) {
    if (err instanceof HTTPError) {
      return await repackageUpstreamError(err.response, 'messages')
    }
    const message = err instanceof Error ? err.message : 'upstream error'
    return jsonErrorWrap(502, { type: 'error', error: { type: 'api_error', message } })
  }
}
