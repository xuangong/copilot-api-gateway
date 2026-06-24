// vnext/packages/gateway/tests/data-plane/chat-flow/shared/kit-deps.test.ts
import { test, expect, beforeAll, afterAll } from 'bun:test'
import { __resetPlatformForTests } from '@vnext-gateway/platform'
import { setupTestPlatform } from '../../../_setup-platform.ts'
import type { KitAuthCtx, KitObsCtx } from '@vnext-gateway/chat-flow-kit'
import { kitDeps } from '../../../../src/data-plane/chat-flow/shared/kit-deps'

beforeAll(() => { setupTestPlatform() })
afterAll(() => { __resetPlatformForTests() })

type Auth = KitAuthCtx & { readonly userId?: string; readonly apiKeyId?: string | null }

function defaultObs(overrides: Partial<KitObsCtx> = {}): KitObsCtx {
  return { apiKeyId: 'k1', userAgent: 'ua', requestId: 'rid', ...overrides }
}

test('buildTelemetryCtx copies apiKeyId/userAgent/requestId from obsCtx, threads isStreaming + requestStartedAt, populates runtimeLocation', () => {
  const startedAt = Date.now()
  const ctx = kitDeps.buildTelemetryCtx({
    auth: { apiKeyId: 'auth-key' } as Auth,
    obsCtx: defaultObs(),
    isStreaming: true,
    requestStartedAt: startedAt,
    endpointTag: 'chat_completions',
  })
  expect(ctx.apiKeyId).toBe('k1')
  expect(ctx.userAgent).toBe('ua')
  expect(ctx.requestId).toBe('rid')
  expect(ctx.isStreaming).toBe(true)
  expect(ctx.requestStartedAt).toBe(startedAt)
  expect(ctx.runtimeLocation).toBeDefined()
  expect(typeof ctx.runtimeLocation).toBe('string')
})

test('buildTelemetryCtx falls back to auth.apiKeyId when obsCtx.apiKeyId is missing', () => {
  const ctx = kitDeps.buildTelemetryCtx({
    auth: { apiKeyId: 'auth-key' } as Auth,
    obsCtx: defaultObs({ apiKeyId: null }),
    isStreaming: false,
    requestStartedAt: 1,
    endpointTag: 't',
  })
  expect(ctx.apiKeyId).toBe('auth-key')
})

test('buildTelemetryCtx falls back to <unknown> when neither obsCtx.apiKeyId nor auth.apiKeyId present', () => {
  const ctx = kitDeps.buildTelemetryCtx({
    auth: {} as Auth,
    obsCtx: defaultObs({ apiKeyId: null }),
    isStreaming: false,
    requestStartedAt: 1,
    endpointTag: 't',
  })
  expect(ctx.apiKeyId).toBe('<unknown>')
})

test('buildTelemetryCtx generates a uuid for requestId when obsCtx.requestId is undefined', () => {
  const ctx = kitDeps.buildTelemetryCtx({
    auth: {} as Auth,
    obsCtx: defaultObs({ requestId: undefined }),
    isStreaming: false,
    requestStartedAt: 1,
    endpointTag: 't',
  })
  expect(ctx.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
})

test('buildTelemetryCtx defaults userAgent to null when obsCtx.userAgent is missing', () => {
  const ctx = kitDeps.buildTelemetryCtx({
    auth: {} as Auth,
    obsCtx: defaultObs({ userAgent: null }),
    isStreaming: false,
    requestStartedAt: 1,
    endpointTag: 't',
  })
  expect(ctx.userAgent).toBeNull()
})

test('runQuotaGate returns null for anonymous (apiKeyId nullish) — wired through', async () => {
  const resp = await kitDeps.runQuotaGate(null)
  expect(resp).toBeNull()
})

test('jsonErrorWrap returns a JSON Response with the given status and body — wired through', async () => {
  const resp = kitDeps.jsonErrorWrap(418, { error: { type: 'teapot', message: 'short and stout' } })
  expect(resp.status).toBe(418)
  expect(resp.headers.get('content-type')).toBe('application/json')
  expect(await resp.json()).toEqual({ error: { type: 'teapot', message: 'short and stout' } })
})
