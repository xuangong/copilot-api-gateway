import { test, expect } from 'bun:test'
import { repackageUpstreamError } from '../src/data-plane/errors/repackage.ts'

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

test('messages source → Anthropic error envelope (400)', async () => {
  const up = jsonRes(400, { error: { message: 'bad model' } })
  const out = await repackageUpstreamError(up, 'messages')
  expect(out.status).toBe(400)
  const body = await out.json() as { type: string; error: { type: string; message: string } }
  expect(body.type).toBe('error')
  expect(body.error.type).toBe('invalid_request_error')
  expect(body.error.message).toContain('bad model')
})

test('chat_completions source → OpenAI error envelope (500)', async () => {
  const up = jsonRes(500, { error: { message: 'boom' } })
  const out = await repackageUpstreamError(up, 'chat_completions')
  expect(out.status).toBe(500)
  const body = await out.json() as { error: { type: string; message: string; code?: string } }
  expect(body.error.type).toBe('api_error')
  expect(body.error.message).toContain('boom')
})

test('responses source → OpenAI Responses error envelope (404)', async () => {
  const up = jsonRes(404, { error: { message: 'model not found' } })
  const out = await repackageUpstreamError(up, 'responses')
  expect(out.status).toBe(404)
  const body = await out.json() as { error: { type: string; message: string } }
  expect(body.error.type).toBe('invalid_request_error')
  expect(body.error.message).toContain('model not found')
})

test('gemini source → Google error envelope (429)', async () => {
  const up = jsonRes(429, { error: { message: 'rate limited' } })
  const out = await repackageUpstreamError(up, 'gemini')
  expect(out.status).toBe(429)
  const body = await out.json() as { error: { code: number; message: string; status: string } }
  expect(body.error.code).toBe(429)
  expect(body.error.status).toBe('RESOURCE_EXHAUSTED')
  expect(body.error.message).toContain('rate limited')
})

test('non-JSON upstream body falls back to raw text', async () => {
  const up = new Response('upstream down', { status: 502, headers: { 'content-type': 'text/plain' } })
  const out = await repackageUpstreamError(up, 'chat_completions')
  expect(out.status).toBe(502)
  const body = await out.json() as { error: { type: string; message: string } }
  expect(body.error.type).toBe('api_error')
  expect(body.error.message).toContain('upstream down')
})

test('unknown sourceApi → generic JSON passthrough', async () => {
  const up = jsonRes(418, { error: { message: 'teapot' } })
  const out = await repackageUpstreamError(up, undefined)
  expect(out.status).toBe(418)
  const body = await out.json() as { error: { message: string } }
  expect(body.error.message).toContain('teapot')
})

test('upstream JSON array body falls back to raw text', async () => {
  const up = jsonRes(500, [{ message: 'x' }])
  const out = await repackageUpstreamError(up, 'chat_completions')
  expect(out.status).toBe(500)
  const body = await out.json() as { error: { type: string; message: string } }
  expect(body.error.type).toBe('api_error')
  expect(body.error.message).toContain('[')
})

test('upstream-provided error.type overrides default for chat_completions', async () => {
  const up = jsonRes(503, { error: { type: 'server_error', message: 'boom' } })
  const out = await repackageUpstreamError(up, 'chat_completions')
  expect(out.status).toBe(503)
  const body = await out.json() as { error: { type: string; message: string } }
  expect(body.error.type).toBe('server_error')
  expect(body.error.message).toBe('boom')
})

