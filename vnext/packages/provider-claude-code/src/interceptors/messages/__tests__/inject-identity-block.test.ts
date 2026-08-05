import { describe, expect, test } from 'bun:test'
import { injectIdentityBlock } from '../inject-identity-block'
import { IDENTITY_BLOCK } from '../system-blocks'
import { makeCtx, runOnce } from './helpers'

describe('injectIdentityBlock', () => {
  test('appends IDENTITY_BLOCK at system[1]', async () => {
    const ctx = makeCtx({
      system: [{ type: 'text', text: 'billing' }],
      messages: [{ role: 'user', content: 'x' }],
    })
    await runOnce(injectIdentityBlock, ctx)
    const system = ctx.payload.system as Array<{ type: string; text: string }>
    expect(system).toHaveLength(2)
    expect(system[1]).toEqual(IDENTITY_BLOCK)
  })
})
