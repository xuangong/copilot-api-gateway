import { test, expect } from 'bun:test'
import { app } from '../src/app.ts'

const env = {} as never

test('POST /v1beta/models/:model:generateContent returns Gemini-shaped body', async () => {
  const req = new Request('http://local/v1beta/models/gemini-1.5-pro:generateContent', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    }),
  })
  const res = await app.fetch(req, env)
  expect(res.status).toBe(200)
  const body = await res.json() as {
    candidates: Array<{
      content: { role: string; parts: Array<{ text?: string }> }
      finishReason: string
    }>
    usageMetadata: { promptTokenCount: number; candidatesTokenCount: number; totalTokenCount: number }
  }
  expect(body.candidates[0]?.content.role).toBe('model')
  expect(body.candidates[0]?.content.parts[0]?.text).toContain('FakeProvider')
  expect(body.candidates[0]?.finishReason).toBe('STOP')
  expect(body.usageMetadata.totalTokenCount).toBeGreaterThan(0)
})

test('POST /v1beta/models/:model:streamGenerateContent returns Gemini SSE chunks', async () => {
  const req = new Request('http://local/v1beta/models/gemini-1.5-pro:streamGenerateContent', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    }),
  })
  const res = await app.fetch(req, env)
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toContain('text/event-stream')
  const text = await res.text()
  const deltas = [...text.matchAll(/"text":"(.*?)"/g)].map((m) => m[1])
  expect(deltas.join('')).toContain('Hello from FakeProvider')
  expect(text).toContain('"finishReason":"STOP"')
})

test('POST /v1beta/models with invalid payload returns Gemini error shape', async () => {
  const req = new Request('http://local/v1beta/models/gemini-1.5-pro:generateContent', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  })
  const res = await app.fetch(req, env)
  expect(res.status).toBe(400)
})
