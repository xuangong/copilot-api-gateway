/**
 * Decision routes — `POST /v1/systemone` and `POST /v1/decisions`.
 *
 * Copilot serves each decision model in one dialect only (Luna on
 * `/v1/decisions`, microsoft-decision-1 on `/v1/systemone`). The gateway
 * forwards a same-dialect request untouched and translates a cross-dialect
 * one, so either ingress reaches either model. The router builds a real
 * CopilotProvider over a stubbed fetch, as the embeddings/images tests do.
 */
import { test, expect, afterEach, beforeEach } from 'bun:test'
import { Hono } from 'hono'
import { initCatalogTestRepo as initRepo, syntheticCopilotTokenResponse } from './helpers/catalog-test-repo.ts'
import { __resetPlatformForTests, initRuntimeLocation } from '@vibe-core/platform'
import type { Repo, UpstreamRecord, UsageRecord } from '../src/repo/types.ts'
import type { Model, ModelsResponse } from '@vibe-llm/provider-copilot'
import type { DataPlaneAuthCtx } from '../src/data-plane/models/routes.ts'
import { decisionRouter } from '../src/data-plane/decision/routes.ts'

const model = (id: string, type: string, supported_endpoints?: string[]): Model => ({
  id, object: 'model', name: id, vendor: 'openai', version: id, model_picker_enabled: false, preview: false,
  capabilities: { family: id, limits: {}, object: 'model_capabilities', supports: {}, tokenizer: 'o200k_base', type },
  ...(supported_endpoints ? { supported_endpoints } : {}),
})
const CATALOG: ModelsResponse = { object: 'list', data: [
  model('gpt-4o', 'chat'),
  model('gpt-6-luna-decisions', 'decisions', ['/v1/decisions']),
  model('microsoft-decision-1', 'decisions', ['/v1/systemone']),
] }

const upstream: UpstreamRecord = {
  id: 'copilot:u1', provider: 'copilot', name: 'u1', enabled: true, sortOrder: 0, config: { githubToken: 'ghp_test' },
  flagOverrides: {}, disabledPublicModelIds: [], state: null, proxyFallbackList: [{ id: 'direct_fetch' }],
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
}

interface UpstreamCall { path: string; body: unknown }
const originalFetch = globalThis.fetch
function installUpstream(answer: (path: string) => Response): UpstreamCall[] {
  const calls: UpstreamCall[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input as string, init)
    const token = syntheticCopilotTokenResponse(req)
    if (token) return token
    const path = new URL(req.url).pathname
    if (path.endsWith('/models')) return Response.json(CATALOG)
    calls.push({ path, body: JSON.parse(await req.text()) })
    return answer(path)
  }) as typeof fetch
  return calls
}

beforeEach(() => { initRuntimeLocation('bun') })
afterEach(() => {
  globalThis.fetch = originalFetch
  __resetPlatformForTests()
})

const COPILOT_AUTH: DataPlaneAuthCtx = { copilot: { copilotToken: 'tkn', accountType: 'individual' } }
const post = (path: string, body: unknown, auth: DataPlaneAuthCtx = COPILOT_AUTH) => {
  const app = new Hono()
  app.use('*', (c, next) => { c.set('auth', auth); return next() })
  app.route('/', decisionRouter)
  return app.request(path, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'content-type': 'application/json' } })
}

const SYSTEM_ONE_REQUEST = {
  model: 'microsoft-decision-1',
  state: 'The API returns 500 on every call.',
  questions: {
    team: { type: 'choice', instructions: 'Which team?', criteria: { billing: 'Charges and refunds', engineering: 'Bugs and outages' } },
    is_bug: { type: 'noul', instructions: 'Is this a bug report?' },
  },
}
const OPENAI_REQUEST = {
  model: 'gpt-6-luna-decisions',
  input: 'The API returns 500 on every call.',
  questions: [
    { type: 'choice', name: 'team', instructions: 'Which team?', choices: [{ value: 'billing', description: 'Charges and refunds' }, { value: 'engineering', description: 'Bugs and outages' }] },
    { type: 'predicate', name: 'is_bug', instructions: 'Is this a bug report?' },
  ],
}
// Number tokens a parsed JavaScript number would rewrite (`1.0` → `1`), so the
// byte-for-byte assertions below would catch a lossy re-serialization.
const SYSTEM_ONE_ANSWER = '{"model":"microsoft-decision-1","answers":{"team":{"type":"choice","choice":"engineering","confidence":1.0,'
  + '"probabilities":{"billing":0.0,"engineering":1.0}},"is_bug":{"type":"noul","noul":0.90}},"usage":{"input_tokens":56,"output_tokens":1}}'
const OPENAI_ANSWER = '{"model":"gpt-6-luna-decisions","answers":[{"type":"choice","name":"team","choice":"engineering","confidence":1.0,'
  + '"probabilities":[{"value":"billing","probability":0.0},{"value":"engineering","probability":1.0}]},'
  + '{"type":"predicate","name":"is_bug","probability":0.90}],"usage":{"input_tokens":61,"output_tokens":2}}'
const json = (text: string, status = 200) => new Response(text, { status, headers: { 'content-type': 'application/json' } })

test('a System One request to a System One model is forwarded and answered byte for byte', async () => {
  initRepo({ upstreams: { list: async () => [upstream] } } as unknown as Repo)
  const calls = installUpstream(() => json(SYSTEM_ONE_ANSWER))
  const res = await post('/v1/systemone', SYSTEM_ONE_REQUEST)
  expect(res.status).toBe(200)
  expect(await res.text()).toBe(SYSTEM_ONE_ANSWER)
  expect(calls).toEqual([{ path: '/v1/systemone', body: SYSTEM_ONE_REQUEST }])
})

test('an OpenAI Decisions request to an OpenAI Decisions model is forwarded and answered byte for byte', async () => {
  initRepo({ upstreams: { list: async () => [upstream] } } as unknown as Repo)
  const calls = installUpstream(() => json(OPENAI_ANSWER))
  const res = await post('/v1/decisions', OPENAI_REQUEST)
  expect(res.status).toBe(200)
  expect(await res.text()).toBe(OPENAI_ANSWER)
  expect(calls).toEqual([{ path: '/v1/decisions', body: OPENAI_REQUEST }])
})

test('a System One request reaches an OpenAI Decisions model and gets a System One answer', async () => {
  initRepo({ upstreams: { list: async () => [upstream] } } as unknown as Repo)
  const calls = installUpstream(() => json(OPENAI_ANSWER))
  const res = await post('/v1/systemone', { ...SYSTEM_ONE_REQUEST, model: 'gpt-6-luna-decisions' })
  expect(res.status).toBe(200)
  expect(calls).toEqual([{ path: '/v1/decisions', body: OPENAI_REQUEST }])
  // Probabilities keep their source tokens through the translation.
  expect(await res.text()).toBe('{"model":"gpt-6-luna-decisions","answers":{"team":{"type":"choice","choice":"engineering",'
    + '"confidence":1.0,"probabilities":{"billing":0.0,"engineering":1.0}},"is_bug":{"type":"noul","noul":0.90}},'
    + '"usage":{"input_tokens":61,"output_tokens":2}}')
})

test('an OpenAI Decisions request reaches a System One model and gets an OpenAI answer', async () => {
  initRepo({ upstreams: { list: async () => [upstream] } } as unknown as Repo)
  const calls = installUpstream(() => json(SYSTEM_ONE_ANSWER))
  const res = await post('/v1/decisions', { ...OPENAI_REQUEST, model: 'microsoft-decision-1' })
  expect(res.status).toBe(200)
  expect(calls).toEqual([{ path: '/v1/systemone', body: SYSTEM_ONE_REQUEST }])
  expect(await res.text()).toBe('{"model":"microsoft-decision-1","answers":[{"type":"choice","name":"team","choice":"engineering",'
    + '"confidence":1.0,"probabilities":[{"value":"billing","probability":0.0},{"value":"engineering","probability":1.0}]},'
    + '{"type":"predicate","name":"is_bug","probability":0.90}],"usage":{"input_tokens":56,"output_tokens":1}}')
})

test('a refused question cannot be expressed in System One and fails explicitly', async () => {
  initRepo({ upstreams: { list: async () => [upstream] } } as unknown as Repo)
  installUpstream(() => json('{"answers":[{"type":"refusal","name":"team"},{"type":"predicate","name":"is_bug","probability":0.5}]}'))
  const res = await post('/v1/systemone', { ...SYSTEM_ONE_REQUEST, model: 'gpt-6-luna-decisions' })
  expect(res.status).toBe(502)
  expect(((await res.json()) as { error: { message: string } }).error.message).toContain('refusal')
})

test('an upstream rejection is forwarded with its status', async () => {
  initRepo({ upstreams: { list: async () => [upstream] } } as unknown as Repo)
  const rejection = '{"error":{"message":"no_available_model_endpoints","code":"no_available_model_endpoints"}}'
  installUpstream(() => json(rejection, 400))
  const res = await post('/v1/systemone', SYSTEM_ONE_REQUEST)
  expect(res.status).toBe(400)
  expect(await res.text()).toBe(rejection)
})

test('malformed requests are rejected before any upstream call', async () => {
  initRepo({ upstreams: { list: async () => [upstream] } } as unknown as Repo)
  const calls = installUpstream(() => json(SYSTEM_ONE_ANSWER))
  for (const [path, body, message] of [
    ['/v1/systemone', '{not json', 'valid JSON'],
    ['/v1/systemone', { ...SYSTEM_ONE_REQUEST, questions: [] }, 'questions must be an object'],
    ['/v1/decisions', { model: 'gpt-6-luna-decisions', questions: OPENAI_REQUEST.questions }, 'input is required'],
  ] as const) {
    const res = await post(path, body)
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain(message)
  }
  expect(calls).toHaveLength(0)
})

test('a request the target dialect cannot express is rejected before any upstream call', async () => {
  initRepo({ upstreams: { list: async () => [upstream] } } as unknown as Repo)
  const calls = installUpstream(() => json(OPENAI_ANSWER))
  for (const [path, body, message] of [
    // OpenAI Decisions requires instructions; System One does not.
    ['/v1/systemone', { ...SYSTEM_ONE_REQUEST, model: 'gpt-6-luna-decisions', questions: { team: { type: 'choice', criteria: { billing: null, engineering: null } } } },
      'questions.team.instructions'],
    // System One keys options by string, so `true` and `"true"` would merge.
    ['/v1/decisions', { ...OPENAI_REQUEST, model: 'microsoft-decision-1', questions: [{ type: 'choice', name: 'flag', instructions: 'Set?', choices: [{ value: true }, { value: 'true' }] }] },
      'collapse to the same System One label'],
  ] as const) {
    const res = await post(path, body)
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain(message)
  }
  expect(calls).toHaveLength(0)
})

test('models without a decision endpoint are not routed', async () => {
  initRepo({ upstreams: { list: async () => [upstream] } } as unknown as Repo)
  const calls = installUpstream(() => json(SYSTEM_ONE_ANSWER))
  for (const id of ['gpt-4o', 'no-such-model']) {
    const res = await post('/v1/systemone', { ...SYSTEM_ONE_REQUEST, model: id })
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain(`No decision upstream available for model: ${id}`)
  }
  expect(calls).toHaveLength(0)
})

test('usage records mapped identities and bills input tokens only', async () => {
  const recorded: UsageRecord[] = []
  initRepo({
    upstreams: { list: async () => [upstream] },
    apiKeys: { getById: async () => null, touchLastUsed: async () => {} },
    usage: { record: async (row: UsageRecord) => { recorded.push(row) } },
    performance: { record: async () => {} },
  } as unknown as Repo)
  const calls = installUpstream(() => json(SYSTEM_ONE_ANSWER))
  const res = await post('/v1/systemone', { ...SYSTEM_ONE_REQUEST, model: 'triage' }, {
    ...COPILOT_AUTH,
    apiKeyId: 'key-1' as never,
    routingPolicy: { modelMappingsEnabled: true, modelMappings: [{ source: 'triage', destination: 'microsoft-decision-1' }] },
  })
  expect(res.status).toBe(200)
  expect(calls).toEqual([{ path: '/v1/systemone', body: SYSTEM_ONE_REQUEST }])
  expect(recorded).toHaveLength(1)
  expect(recorded[0]).toMatchObject({ incomingModel: 'triage', model: 'microsoft-decision-1', modelKey: 'microsoft-decision-1',
    upstream: 'copilot:u1', requests: 1, tokens: { input: 56 } })
  expect(recorded[0]!.tokens).toEqual({ input: 56 })
})

test('number tokens in the request reach the model unchanged', async () => {
  initRepo({ upstreams: { list: async () => [upstream] } } as unknown as Repo)
  const sent: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input as string, init)
    const token = syntheticCopilotTokenResponse(req)
    if (token) return token
    if (new URL(req.url).pathname.endsWith('/models')) return Response.json(CATALOG)
    sent.push(await req.text())
    return json(SYSTEM_ONE_ANSWER)
  }) as typeof fetch
  const body = '{"model":"microsoft-decision-1","state":{"price":1.50,"qty":2},"questions":{"is_bug":{"type":"noul","instructions":"Bug?"}}}'
  expect((await post('/v1/systemone', body)).status).toBe(200)
  expect(sent[0]).toContain('"state":{"price":1.50,"qty":2}')
  // Across dialects the structured state rides in an OpenAI `input_json` part, digits intact.
  expect((await post('/v1/systemone', body.replace('microsoft-decision-1', 'gpt-6-luna-decisions'))).status).toBe(502)
  expect(sent[1]).toContain('"input":[{"role":"user","content":[{"type":"input_json","data":{"price":1.50,"qty":2}}]}]')
})
