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

test('dump retains Responses source model before routing an immutable payload', async () => {
  initResponsesStore(new InMemoryResponsesSnapshotStore())
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
  const raw = { model: 'source', input: 'hello' }
  const { response } = await serveResponses({ raw, auth, obsCtx, dump })

  expect(requested).toEqual(['source'])
  expect(raw.model).toBe('source')
  expect(response.status).toBe(404)
})
