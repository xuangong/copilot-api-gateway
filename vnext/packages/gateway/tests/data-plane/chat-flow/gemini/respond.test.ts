// vnext/packages/gateway/tests/data-plane/chat-flow/gemini/respond.test.ts
/**
 * Coverage for `gemini/respond.ts` — the renderer that converts a
 * `GeminiAttemptResult` (`ExecuteResult<unknown>`) into a client `Response`.
 *
 * Two render branches:
 *   - `wantsStream === true`: data-only SSE per gemini convention
 *     (`data: <json>\n\n`, no `event:` prefix, no `[DONE]`).
 *   - `wantsStream === false`: drain stream into a single `GeminiResult`
 *     envelope and emit JSON.
 *
 * Plus error envelope shapes (`{error: {message}}` at the result's status).
 *
 * Telemetry persistence is exercised separately in state-bridge.test.ts —
 * here we omit `telemetryCtx` so no usage/perf rows are required.
 */
import { test, expect } from 'bun:test'
import { respondGemini } from '../../../../src/data-plane/chat-flow/gemini/respond.ts'
import {
  eventResult,
  internalErrorResult,
  type TelemetryModelIdentity,
} from '@vnext/protocols/common'

const stubIdentity: TelemetryModelIdentity = {
  model: '<unknown>',
  upstream: '<unknown>',
  modelKey: 'gemini-2.5-pro',
  cost: null,
}

const okEvents = async function* (): AsyncGenerator<unknown> {
  yield {
    candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'hi' }] } }],
    modelVersion: 'gemini-2.5-pro',
  }
  yield {
    candidates: [{
      index: 0,
      content: { role: 'model', parts: [{ text: ' there' }] },
      finishReason: 'STOP',
    }],
    usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 4 },
    modelVersion: 'gemini-2.5-pro',
    responseId: 'resp-1',
  }
}

test('events + wantsStream=true → SSE data-only frames, no [DONE]', async () => {
  const resp = await respondGemini(eventResult(okEvents(), stubIdentity), { wantsStream: true })
  expect(resp.status).toBe(200)
  expect(resp.headers.get('content-type')).toContain('text/event-stream')
  const body = await resp.text()
  // Each frame is `data: <json>\n\n` — no `event:` prefix, no `[DONE]`.
  expect(body).toContain('data: {')
  expect(body).not.toContain('event: ')
  expect(body).not.toContain('[DONE]')
  expect(body).toContain('"text":"hi"')
  expect(body).toContain('"text":" there"')
  expect(body).toContain('"finishReason":"STOP"')
})

test('events + wantsStream=false → JSON envelope with concatenated text + final usage/modelVersion', async () => {
  const resp = await respondGemini(eventResult(okEvents(), stubIdentity), { wantsStream: false })
  expect(resp.status).toBe(200)
  expect(resp.headers.get('content-type')).toContain('application/json')
  const json = (await resp.json()) as {
    candidates: Array<{ content: { parts: Array<{ text?: string }> }; finishReason?: string }>
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number }
    modelVersion?: string
    responseId?: string
  }
  expect(json.candidates).toHaveLength(1)
  expect(json.candidates[0]!.content.parts[0]!.text).toBe('hi there')
  expect(json.candidates[0]!.finishReason).toBe('STOP')
  expect(json.usageMetadata?.promptTokenCount).toBe(5)
  expect(json.usageMetadata?.candidatesTokenCount).toBe(4)
  expect(json.modelVersion).toBe('gemini-2.5-pro')
  expect(json.responseId).toBe('resp-1')
})

test('internal-error → JSON {error:{message}} envelope at the given status', async () => {
  const resp = await respondGemini(internalErrorResult(404, new Error('model not found: x')), {
    wantsStream: false,
  })
  expect(resp.status).toBe(404)
  expect(resp.headers.get('content-type')).toContain('application/json')
  const json = (await resp.json()) as { error: { message?: string } }
  expect(json.error?.message).toContain('model not found')
})

test('upstream-error → repackaged into gemini error envelope, status preserved', async () => {
  const resp = await respondGemini(
    {
      type: 'upstream-error',
      status: 429,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: new TextEncoder().encode(JSON.stringify({ error: { message: 'slow down' } })),
    },
    { wantsStream: true },
  )
  expect(resp.status).toBe(429)
  // Body is the gemini-shape envelope from `repackageUpstreamError(_, 'gemini')`.
  const json = (await resp.json()) as { error?: { message?: string } }
  expect(typeof json.error?.message).toBe('string')
})

test('events + wantsStream=false carries non-text parts (functionCall) verbatim', async () => {
  const events = async function* (): AsyncGenerator<unknown> {
    yield {
      candidates: [{
        index: 0,
        content: {
          role: 'model',
          parts: [
            { text: 'lookup ' },
            { functionCall: { name: 'getWeather', args: { city: 'sf' } } },
          ],
        },
        finishReason: 'STOP',
      }],
      usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1 },
      modelVersion: 'gemini-2.5-pro',
    }
  }
  const resp = await respondGemini(eventResult(events(), stubIdentity), { wantsStream: false })
  const json = (await resp.json()) as {
    candidates: Array<{ content: { parts: Array<{ text?: string; functionCall?: unknown }> } }>
  }
  const parts = json.candidates[0]!.content.parts
  expect(parts.find(p => p.text === 'lookup ')).toBeDefined()
  expect(parts.find(p => p.functionCall !== undefined)).toBeDefined()
})

test('events + wantsStream=false: error frame from translator short-circuits to gemini error envelope', async () => {
  const events = async function* (): AsyncGenerator<unknown> {
    yield { error: { code: 500, message: 'boom', status: 'INTERNAL' } }
  }
  const resp = await respondGemini(eventResult(events(), stubIdentity), { wantsStream: false })
  // We render the error frame as the response body verbatim; status 200 because
  // the frame surfaced AFTER the upstream-error gate (mid-stream from the
  // translator's POV). This matches legacy dispatch behaviour.
  expect(resp.status).toBe(200)
  const json = (await resp.json()) as { error: { message: string } }
  expect(json.error.message).toBe('boom')
})
