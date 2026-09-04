// packages/gateway/src/data-plane/chat-flow/gemini/count-tokens.ts
//
// Gemini-native :countTokens handler. Translates the Gemini request body to
// an Anthropic Messages payload, dispatches to a binding's
// messages_count_tokens endpoint, then reshapes the upstream
// `{ input_tokens }` / `{ total_tokens }` envelope into Gemini's
// `{ totalTokens }` shape.
import type { DataPlaneAuthCtx } from '../../models/routes.ts'
import { parseGeminiPayload } from '../../parsers.ts'
import { resolveBinding } from '../../routing/binding-resolver.ts'
import { resolveKeyModel } from '../../routing/key-model-mapping.ts'
import { forwardUpstreamError } from '../../errors/forward.ts'
import { HTTPError } from '@vibe-llm/provider-copilot'
import { jsonErrorWrap } from '../shared/error-wrap.ts'
import { translateGeminiToMessages } from '@vibe-llm/translate/gemini-via-messages'
import { reshapeMessagesCountAsGemini } from './reshape-count.ts'
import type { DumpAccumulator } from '../../../shared/dump/accumulator.ts'

export interface GeminiCountTokensServeArgs {
  raw: unknown
  model: string
  auth: DataPlaneAuthCtx
  signal?: AbortSignal
  dump?: DumpAccumulator | null
}

export async function serveGeminiCountTokens(args: GeminiCountTokensServeArgs): Promise<Response> {
  const tee = (r: Response): Response => (args.dump ? args.dump.finalize(r) : r)
  if (args.dump && args.model) args.dump.requestedModel(args.model)
  let geminiPayload
  try { geminiPayload = parseGeminiPayload(args.raw) }
  catch (err) {
    const e = err as Error & { status?: number; body?: unknown }
    return tee(jsonErrorWrap(
      e.status ?? 400,
      e.body ?? { error: { code: 400, message: e.message, status: 'INVALID_ARGUMENT' } },
    ))
  }

  const resolved = resolveKeyModel(args.model, args.auth.routingPolicy)
  const messagesPayload = translateGeminiToMessages(geminiPayload, { model: resolved.routedModel })

  const binding = await resolveBinding(resolved.routedModel, 'messages_count_tokens', {
    ownerId: args.auth.userId,
    copilot: args.auth.copilot,
    pin: resolved.upstreamPin,
  })
  if (!binding) {
    return tee(jsonErrorWrap(404, {
      error: {
        code: 404,
        message: `No messages_count_tokens upstream available for model: ${args.model}.`,
        status: 'NOT_FOUND',
      },
    }))
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
      return tee(jsonErrorWrap(response.status, {
        error: {
          code: response.status,
          message: text || 'Upstream token counting request failed.',
          status: 'UNKNOWN',
        },
      }))
    }
    let decoded: unknown
    try { decoded = await response.json() } catch {}
    const reshaped = reshapeMessagesCountAsGemini(decoded)
    if (!reshaped) {
      return tee(jsonErrorWrap(502, {
        error: { code: 502, message: 'Invalid upstream token counting response.', status: 'UNKNOWN' },
      }))
    }
    return tee(Response.json(reshaped, { status: 200 }))
  } catch (err) {
    if (err instanceof HTTPError) {
      return tee(await forwardUpstreamError(err.response, 'gemini'))
    }
    const message = err instanceof Error ? err.message : 'upstream error'
    return tee(jsonErrorWrap(502, { error: { code: 502, message, status: 'UNKNOWN' } }))
  }
}
