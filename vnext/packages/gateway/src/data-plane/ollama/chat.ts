/**
 * `POST /api/chat` — Ollama's chat endpoint, served by our own pipeline.
 *
 * This is a *wire-format shim*, deliberately not a fifth chat-flow endpoint.
 * The alternative — a `chat-flow/ollama/{http,serve,attempt,respond}.ts` set
 * like gemini has — would mean reimplementing everything
 * `chat-flow/chat-completions/respond.ts` already owns: usage/perf persistence
 * under waitUntil, SSE keepalive, downstream-abort propagation, upstream error
 * repackaging, and above all the cross-protocol reassembly that dispatches on
 * `translatorPair.hub`. That last one is not an edge case — several models
 * (`gpt-5.6-sol` among them) resolve to the Responses endpoint upstream, so a
 * hand-rolled responder would work for some models and not others.
 *
 * So: translate the body in, call `serveChatCompletions` unchanged, translate
 * the frames out. The extra serialize→parse on the streaming path is in-process
 * string work with no additional network hop, and it is done frame by frame so
 * time-to-first-token is unaffected.
 */
import type { Context } from 'hono'
import type { Env } from '../../app.ts'
import { serveChatCompletions } from '../chat-flow/chat-completions/serve.ts'
import { readAuth, readObsCtx } from '../chat-flow/shared/gateway-ctx.ts'
import { openRequestDump, parseJsonBody } from '../chat-flow/shared/dump-open.ts'
import { parseChatSSEStream } from '@vibe-llm/provider-copilot'
import {
  OllamaStreamState,
  ollamaToOpenAIBody,
  openAIJsonToOllama,
  timings,
  type OllamaChatRequest,
  type OpenAIStreamChunk,
} from './wire.ts'

const NDJSON = { 'content-type': 'application/x-ndjson' } as const

const badRequest = (message: string): Response =>
  Response.json({ error: message }, { status: 400 })

export async function ollamaChatHandler(c: Context<{ Bindings: Env }>): Promise<Response> {
  const auth = readAuth(c)
  const { requestBody, dump } = await openRequestDump(c, auth, c.req.method)

  let body: OllamaChatRequest
  try {
    body = parseJsonBody(requestBody.bytes) as OllamaChatRequest
  } catch {
    const res = badRequest('invalid JSON')
    return dump ? dump.finalize(res) : res
  }
  if (!body || typeof body.model !== 'string') {
    const res = badRequest('model is required')
    return dump ? dump.finalize(res) : res
  }

  // Ollama defaults `stream` to true when the field is absent.
  const wantsStream = body.stream !== false
  const startMs = performance.now()
  const createdAt = new Date().toISOString()

  const upstream = await serveChatCompletions({
    raw: ollamaToOpenAIBody(body),
    auth,
    obsCtx: readObsCtx(c, auth),
    signal: c.req.raw.signal,
    dump,
  })

  // Errors pass through untouched: ollama-js reads `.error` off a non-2xx JSON
  // body, and our error envelope already carries a message it can surface.
  if (!upstream.ok) return upstream

  if (!wantsStream) {
    const json = await upstream.json() as Parameters<typeof openAIJsonToOllama>[0]
    const endMs = performance.now()
    return Response.json(
      openAIJsonToOllama(
        json,
        body.model,
        createdAt,
        timings(
          startMs,
          null,
          endMs,
          json.usage?.prompt_tokens ?? 0,
          json.usage?.completion_tokens ?? 0,
        ),
      ),
    )
  }

  const state = new OllamaStreamState()
  const encoder = new TextEncoder()
  let firstTokenMs: number | null = null

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (line: string | null) => {
        if (line !== null) controller.enqueue(encoder.encode(line + '\n'))
      }
      try {
        for await (const chunk of parseChatSSEStream(upstream.body, c.req.raw.signal)) {
          const line = state.chunkToLine(chunk as OpenAIStreamChunk, body.model, createdAt)
          if (line !== null && firstTokenMs === null) firstTokenMs = performance.now()
          write(line)
        }
        write(state.toolCallLine(body.model, createdAt))
        write(state.doneLine(
          body.model,
          createdAt,
          timings(startMs, firstTokenMs, performance.now(), state.promptTokens, state.completionTokens),
        ))
      } catch {
        // The client went away, or the upstream stream broke. Either way the
        // terminal frame is what tells ollama-js to stop reading, so emit it
        // rather than leaving the reader hanging on a truncated stream.
        write(state.doneLine(
          body.model,
          createdAt,
          timings(startMs, firstTokenMs, performance.now(), state.promptTokens, state.completionTokens),
        ))
      } finally {
        controller.close()
      }
    },
  })

  return new Response(stream, { status: 200, headers: NDJSON })
}
