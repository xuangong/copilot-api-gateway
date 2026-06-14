/**
 * Integration test: dispatch returns 429 when API key token quota is exceeded.
 *
 * Pattern after tests/messages.e2e.test.ts: wrap innerApp in a Hono shim that
 * pre-populates c.set('auth', authCtx). Use a real SqliteRepo so checkQuota can
 * call repo.apiKeys.getById + repo.usage.query against real data.
 */
import { test, expect, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { Hono } from 'hono'
import { app as innerApp } from '../../src/app.ts'
import { initRepo } from '../../src/shared/repo/index.ts'
import { __resetPlatformForTests } from '@vnext/platform'
import { SqliteRepo } from '../../src/shared/repo/sqlite.ts'
import type { DataPlaneAuthCtx } from '../../src/data-plane/models/routes.ts'
import type { Model, ModelsResponse } from '@vnext/provider-copilot'

const env = {} as never

const MODEL_ID = 'claude-3-5-sonnet-20241022'
const COPILOT_TOKEN = 'tkn'
const ACCOUNT_TYPE = 'individual' as const

const stubModel = (id: string): Model => ({
  id,
  object: 'model',
  name: id,
  vendor: 'anthropic',
  version: id,
  model_picker_enabled: true,
  preview: false,
  capabilities: {
    family: 'claude',
    limits: { max_context_window_tokens: 200000, max_output_tokens: 8192 },
    object: 'model_capabilities',
    supports: {},
    tokenizer: 'cl100k',
    type: 'text',
  },
})

const originalFetch = globalThis.fetch
type FetchHandler = (req: Request) => Promise<Response> | Response
function installFetch(handler: FetchHandler) {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input as string, init)
    return Promise.resolve(handler(req))
  }) as typeof fetch
}

afterEach(() => {
  globalThis.fetch = originalFetch
  __resetPlatformForTests()
})

function buildApp(auth: DataPlaneAuthCtx) {
  const wrapper = new Hono()
  wrapper.use('*', (c, next) => { c.set('auth', auth); return next() })
  wrapper.route('/', innerApp)
  return wrapper
}

test('dispatch returns 429 when token quota exceeded', async () => {
  // Set up a real SqliteRepo in-memory
  const db = new Database(':memory:')
  const repo = new SqliteRepo(db)

  // Save an api key with quotaTokensPerDay: 100
  await repo.apiKeys.save({
    id: 'k1',
    name: 'k',
    key: 'sk-test',
    createdAt: new Date().toISOString(),
    quotaTokensPerDay: 100,
  })

  // Pre-fill usage so weighted tokens exceed 100
  // weighted = cacheRead*0.1 + input*1.0 + output*5.0
  // input=1000 → weighted=1000, which exceeds 100
  const todayHour = new Date().toISOString().slice(0, 13)
  await repo.usage.record({
    keyId: 'k1', model: 'm', modelKey: 'm', upstream: null, client: '',
    hour: todayHour, requests: 1, tokens: { input: 1000 }, cost: null,
  })

  // Save a Copilot upstream so enumerateBindingCandidates can find the model
  await repo.upstreams.save({
    id: 'copilot:u1',
    provider: 'copilot',
    name: 'u1',
    enabled: true,
    sortOrder: 0,
    config: { githubToken: 'ghp_test' },
    flagOverrides: {},
    disabledPublicModelIds: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  })

  initRepo(repo)

  // Stub globalThis.fetch so the Copilot provider returns a model list
  // containing MODEL_ID, so enumerateBindingCandidates succeeds
  installFetch((req) => {
    const url = new URL(req.url)
    if (url.pathname.endsWith('/models')) {
      return new Response(
        JSON.stringify({ object: 'list', data: [stubModel(MODEL_ID)] } satisfies ModelsResponse),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    // Quota check fires before upstream POST, so this should never be reached
    return new Response('should not reach upstream', { status: 500 })
  })

  // Build app with auth that has apiKeyId: 'k1' + copilot creds so provider binding resolves
  const app = buildApp({ apiKeyId: 'k1', copilot: { copilotToken: COPILOT_TOKEN, accountType: ACCOUNT_TYPE } })

  const res = await app.fetch(
    new Request('http://local/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL_ID,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    }),
    env,
  )

  expect(res.status).toBe(429)
  const body = await res.json() as { error: { type: string; message: string } }
  expect(body.error.type).toBe('rate_limit_error')
})
