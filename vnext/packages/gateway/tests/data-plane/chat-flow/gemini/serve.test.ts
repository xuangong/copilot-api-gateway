import { afterAll, beforeAll, expect, test } from 'bun:test'
import { __resetPlatformForTests } from '@vibe-core/platform'
import { setupTestPlatform } from '../../../_setup-platform.ts'
import { serveGemini } from '../../../../src/data-plane/chat-flow/gemini/serve.ts'
import type { DataPlaneAuthCtx } from '../../../../src/data-plane/models/routes.ts'
import type { DispatchObsCtx } from '../../../../src/data-plane/chat-flow/shared/obs-ctx.ts'

beforeAll(() => { setupTestPlatform() })
afterAll(() => { __resetPlatformForTests() })

const auth: DataPlaneAuthCtx = {
  userId: 'owner',
  routingPolicy: { modelMappingsEnabled: true, modelMappings: [{ source: 'normalized-source', destination: 'destination' }] },
}
const obsCtx: DispatchObsCtx = { apiKeyId: 'key', userAgent: 'test', requestId: 'request' }

test('dump retains normalized Gemini source before routing to a distinct destination', async () => {
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
  const response = await serveGemini({
    raw: { contents: [] }, model: 'normalized-source', forceStream: false, auth, obsCtx, dump,
  })

  expect(requested).toEqual(['normalized-source'])
  expect(response.status).toBe(404)
})
