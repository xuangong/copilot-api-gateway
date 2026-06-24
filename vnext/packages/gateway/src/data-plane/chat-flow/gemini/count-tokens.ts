// packages/gateway/src/data-plane/chat-flow/gemini/count-tokens.ts
//
// Gemini-native :countTokens handler. Translates the Gemini request body to
// an Anthropic Messages payload, dispatches to a binding's
// messages_count_tokens endpoint, then reshapes the upstream
// `{ input_tokens }` / `{ total_tokens }` envelope into Gemini's
// `{ totalTokens }` shape.
import type { DataPlaneAuthCtx } from '../../models/routes.ts'
import { parseGeminiPayload } from '../../parsers.ts'
import { resolveBinding, stripUpstreamPin } from '../../routing/binding-resolver.ts'
import { repackageUpstreamError } from '../../errors/repackage.ts'
import { HTTPError } from '@vnext/provider-copilot'
import { jsonErrorWrap } from '../shared/error-wrap.ts'
import { translateGeminiToMessages } from '@vnext-llm/translate/gemini-via-messages'
import { reshapeMessagesCountAsGemini } from './reshape-count.ts'

export interface GeminiCountTokensServeArgs {
  raw: unknown
  model: string
  auth: DataPlaneAuthCtx
  signal?: AbortSignal
}

export async function serveGeminiCountTokens(args: GeminiCountTokensServeArgs): Promise<Response> {
  let geminiPayload
  try { geminiPayload = parseGeminiPayload(args.raw) }
  catch (err) {
    const e = err as Error & { status?: number; body?: unknown }
    return jsonErrorWrap(
      e.status ?? 400,
      e.body ?? { error: { code: 400, message: e.message, status: 'INVALID_ARGUMENT' } },
    )
  }

  const messagesPayload = translateGeminiToMessages(geminiPayload, { model: args.model })
  stripUpstreamPin(messagesPayload as unknown as Record<string, unknown>)

  const binding = await resolveBinding(args.model, 'messages_count_tokens', {
    ownerId: args.auth.userId,
    copilot: args.auth.copilot,
  })
  if (!binding) {
    return jsonErrorWrap(404, {
      error: {
        code: 404,
        message: `No messages_count_tokens upstream available for model: ${args.model}.`,
        status: 'NOT_FOUND',
      },
    })
  }

  try {
    const headers = new Headers({ 'content-type': 'application/json' })
    const pr = await binding.provider.fetch({
      endpoint: 'messages_count_tokens',
      payload: messagesPayload,
      headers,
      sourceApi: 'gemini',
      operationName: 'count tokens',
      flags: { isStreaming: false },
      signal: args.signal,
    })
    const response = new Response(pr.body, { status: pr.status, headers: pr.headers })
    if (response.status !== 200) {
      const text = await response.text()
      return jsonErrorWrap(response.status, {
        error: {
          code: response.status,
          message: text || 'Upstream token counting request failed.',
          status: 'UNKNOWN',
        },
      })
    }
    let decoded: unknown
    try { decoded = await response.json() } catch {}
    const reshaped = reshapeMessagesCountAsGemini(decoded)
    if (!reshaped) {
      return jsonErrorWrap(502, {
        error: { code: 502, message: 'Invalid upstream token counting response.', status: 'UNKNOWN' },
      })
    }
    return Response.json(reshaped, { status: 200 })
  } catch (err) {
    if (err instanceof HTTPError) {
      return await repackageUpstreamError(err.response, 'gemini')
    }
    const message = err instanceof Error ? err.message : 'upstream error'
    return jsonErrorWrap(502, { error: { code: 502, message, status: 'UNKNOWN' } })
  }
}
