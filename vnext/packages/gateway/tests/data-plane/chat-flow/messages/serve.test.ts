import { afterAll, beforeAll, expect, test } from 'bun:test'
import { __resetPlatformForTests } from '@vibe-core/platform'
import { setupTestPlatform } from '../../../_setup-platform.ts'
import { serveMessages } from '../../../../src/data-plane/chat-flow/messages/serve.ts'
import type { DataPlaneAuthCtx } from '../../../../src/data-plane/models/routes.ts'
import type { DispatchObsCtx } from '../../../../src/data-plane/chat-flow/shared/obs-ctx.ts'

beforeAll(() => { setupTestPlatform() })
afterAll(() => { __resetPlatformForTests() })

const auth: DataPlaneAuthCtx = {
  userId: 'owner',
  routingPolicy: { modelMappingsEnabled: true, modelMappings: [{ source: 'source', destination: 'destination' }] },
}
const obsCtx: DispatchObsCtx = { apiKeyId: 'key', userAgent: 'test', requestId: 'request' }

test('dump retains Messages source model before routing an immutable payload', async () => {
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
  const raw = { model: 'source', max_tokens: 1, messages: [] }
  const response = await serveMessages({ raw, auth, obsCtx, dump })

  expect(requested).toEqual(['source'])
  expect(raw.model).toBe('source')
  expect(response.status).toBe(404)
})
