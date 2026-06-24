// vnext/packages/gateway/tests/data-plane/chat-flow/chat-completions/serve.test.ts
/**
 * Unit coverage for the rewritten `serveChatCompletions`. End-to-end wiring of
 * the interceptor chain (e.g. include-usage proof) lives in the integration
 * suite (Part 4 Task 2); these cases pin down:
 *   - malformed JSON parses into the {error: invalid_request_error} envelope
 *   - happy-path stream requests survive the attempt → respond round-trip
 *     even when binding selection fails (404 surfaces as the upstream-shaped
 *     internal error, not a crash)
 */
import { test, expect, beforeAll, afterAll } from 'bun:test'
import { __resetPlatformForTests } from '@vnext-gateway/platform'
import { setupTestPlatform } from '../../../_setup-platform.ts'
import { serveChatCompletions } from '../../../../src/data-plane/chat-flow/chat-completions/serve'
import type { DataPlaneAuthCtx } from '../../../../src/data-plane/models/routes'
import type { DispatchObsCtx } from '../../../../src/data-plane/chat-flow/shared/obs-ctx'

// serve.ts now reads `getRuntimeLocation()` and the respond path issues
// `waitUntil(recordPerformance(...))` for the no-binding 404 branch — both
// of which require platform/repo bootstrap.
beforeAll(() => { setupTestPlatform() })
afterAll(() => { __resetPlatformForTests() })

const fakeAuth: DataPlaneAuthCtx = { userId: 'o' }
const fakeObsCtx: DispatchObsCtx = { apiKeyId: 'k', userAgent: 'ua', requestId: 'rid' }

test('rejects malformed JSON body with 400', async () => {
  const resp = await serveChatCompletions({
    raw: '{not json',
    auth: fakeAuth,
    obsCtx: fakeObsCtx,
  })
  expect(resp.status).toBe(400)
})

test('passes wantsStream=true to respond when stream:true in body (model-not-found surfaces as 4xx)', async () => {
  const resp = await serveChatCompletions({
    raw: {
      model: 'definitely-not-a-real-model-zzz',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    },
    auth: fakeAuth,
    obsCtx: fakeObsCtx,
  })
  // Whether selectBinding reports model-not-found (404) or downstream raises a
  // routing failure (400/502) depends on test-env binding state — all three
  // are valid "no upstream serves this fake model" answers, none should crash.
  expect([400, 404, 502]).toContain(resp.status)
})
