import { test, expect } from 'bun:test'
import type { ProviderRequest, ProviderResponse, ProviderRequestFlags, SourceApi } from '../src/types'

test('ProviderRequest shape compiles', () => {
  const req: ProviderRequest = {
    endpoint: 'messages',
    payload: { model: 'm', messages: [] },
    headers: new Headers(),
    sourceApi: 'anthropic',
    flags: { isStreaming: false },
  }
  expect(req.endpoint).toBe('messages')
})

test('ProviderResponse shape compiles', () => {
  const res: ProviderResponse = {
    status: 200,
    headers: new Headers(),
    body: null,
  }
  expect(res.status).toBe(200)
})

test('SourceApi members', () => {
  const a: SourceApi = 'anthropic'
  const b: SourceApi = 'openai'
  const c: SourceApi = 'gemini'
  expect([a, b, c]).toEqual(['anthropic', 'openai', 'gemini'])
})

// Reference the flags type so TS doesn't drop it as unused.
const _flags: ProviderRequestFlags = { isStreaming: true }
void _flags
