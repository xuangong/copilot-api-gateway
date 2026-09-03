import { afterAll, beforeAll, expect, test } from 'bun:test'
import { __resetPlatformForTests } from '@vibe-core/platform'
import { setupTestPlatform } from '../../../_setup-platform.ts'
import { initResponsesStore } from '../../../../src/data-plane/runtime/responses-store.ts'
import { serveResponses } from '../../../../src/data-plane/chat-flow/responses/serve.ts'
import type { DataPlaneAuthCtx } from '../../../../src/data-plane/models/routes.ts'
import type { DispatchObsCtx } from '../../../../src/data-plane/chat-flow/shared/obs-ctx.ts'
import { InMemoryResponsesSnapshotStore } from '@vibe-llm/responses-store'

beforeAll(() => { setupTestPlatform() })
afterAll(() => { __resetPlatformForTests() })

const auth: DataPlaneAuthCtx = {
  userId: 'owner', apiKeyId: 'key',
  routingPolicy: { modelMappingsEnabled: true, modelMappings: [{ source: 'source', destination: 'destination' }] },
}
const obsCtx: DispatchObsCtx = { apiKeyId: 'key', userAgent: 'test', requestId: 'request' }

test('compact dump retains source while previous response is expanded and model is routed', async () => {
  const store = new InMemoryResponsesSnapshotStore()
  await store.save({
    responseId: 'resp_previous', apiKeyId: 'key', model: 'old-model',
    items: [{ type: 'message', role: 'user', content: 'earlier work' }],
    createdAt: Date.now(), expiresAt: Date.now() + 60_000,
  })
  initResponsesStore(store)
  const requested: string[] = []
  const dump = {
    requestedModel: (model: string) => { requested.push(model) },
    finalize: (response: Response) => response,
    failed: (_message: string) => {},
    success: () => {},
    frame: () => {},
    recordSentPayloadBytes: () => {},
    error: () => {},
  }
  const raw = {
    model: 'source', previous_response_id: 'resp_previous',
    input: [{ type: 'message', role: 'user', content: 'current work' }],
  }
  const { response, mergedInputItems } = await serveResponses({ raw, auth, obsCtx, dump, action: 'compact' })

  expect(requested).toEqual(['source'])
  expect(raw.model).toBe('source')
  expect(raw.previous_response_id).toBe('resp_previous')
  expect(mergedInputItems).toEqual([
    { type: 'message', role: 'user', content: 'earlier work' },
    { type: 'message', role: 'user', content: 'current work' },
  ])
  expect(response.status).toBe(404)
})
