import { describe, expect, test } from 'bun:test'
import { synthesizeMetadataUserId } from '../synthesize-metadata-user-id'
import { makeCtx, runOnce } from './helpers'

const parseUserId = (raw: unknown): { device_id: string; account_uuid: string; session_id: string } =>
  JSON.parse(raw as string) as { device_id: string; account_uuid: string; session_id: string }

const UUIDV4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('synthesizeMetadataUserId', () => {
  test('same upstreamId + first user text → identical user_id', async () => {
    const build = () =>
      makeCtx(
        { messages: [{ role: 'user', content: 'hello world' }] },
        { upstreamId: 'up-1' },
      )
    const ctxA = build()
    const ctxB = build()
    await runOnce(synthesizeMetadataUserId, ctxA)
    await runOnce(synthesizeMetadataUserId, ctxB)
    const a = parseUserId((ctxA.payload.metadata as { user_id: string }).user_id)
    const b = parseUserId((ctxB.payload.metadata as { user_id: string }).user_id)
    expect(a).toEqual(b)
  })

  test('different upstreamIds → different device_ids', async () => {
    const ctxA = makeCtx({ messages: [{ role: 'user', content: 'x' }] }, { upstreamId: 'up-1' })
    const ctxB = makeCtx({ messages: [{ role: 'user', content: 'x' }] }, { upstreamId: 'up-2' })
    await runOnce(synthesizeMetadataUserId, ctxA)
    await runOnce(synthesizeMetadataUserId, ctxB)
    const a = parseUserId((ctxA.payload.metadata as { user_id: string }).user_id)
    const b = parseUserId((ctxB.payload.metadata as { user_id: string }).user_id)
    expect(a.device_id).not.toBe(b.device_id)
  })

  test('device_id is 64-hex; session_id is UUIDv4; account_uuid is empty', async () => {
    const ctx = makeCtx({ messages: [{ role: 'user', content: 'x' }] })
    await runOnce(synthesizeMetadataUserId, ctx)
    const parsed = parseUserId((ctx.payload.metadata as { user_id: string }).user_id)
    expect(parsed.device_id).toMatch(/^[0-9a-f]{64}$/)
    expect(parsed.session_id).toMatch(UUIDV4_RE)
    expect(parsed.account_uuid).toBe('')
  })

  test('preserves existing metadata.user_id', async () => {
    const ctx = makeCtx({
      messages: [{ role: 'user', content: 'x' }],
      metadata: { user_id: 'pre-existing' },
    })
    await runOnce(synthesizeMetadataUserId, ctx)
    expect((ctx.payload.metadata as { user_id: string }).user_id).toBe('pre-existing')
  })

  test('handles block-array user content when computing session_id', async () => {
    const ctx = makeCtx({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'block text' }] }],
    })
    await runOnce(synthesizeMetadataUserId, ctx)
    const parsed = parseUserId((ctx.payload.metadata as { user_id: string }).user_id)
    expect(parsed.session_id).toMatch(UUIDV4_RE)
  })
})
