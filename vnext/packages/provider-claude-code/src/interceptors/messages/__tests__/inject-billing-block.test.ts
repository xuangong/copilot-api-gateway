import { describe, expect, test } from 'bun:test'
import { injectBillingBlock } from '../inject-billing-block'
import { makeCtx, runOnce } from './helpers'
import { CLAUDE_CLI_VERSION } from '../../../headers'

describe('injectBillingBlock', () => {
  test('resets system to [billing], billing text matches shape with 3-hex fp', async () => {
    const ctx = makeCtx({
      system: [{ type: 'text', text: 'stale' }],
      messages: [{ role: 'user', content: 'hello' }],
    })
    await runOnce(injectBillingBlock, ctx)
    expect(Array.isArray(ctx.payload.system)).toBe(true)
    const system = ctx.payload.system as Array<{ type: string; text: string }>
    expect(system).toHaveLength(1)
    const re = new RegExp(
      `^x-anthropic-billing-header: cc_version=${CLAUDE_CLI_VERSION.replace(/\./g, '\\.')}\\.[0-9a-f]{3}; cc_entrypoint=cli; cch=00000;$`,
    )
    expect(system[0]!.text).toMatch(re)
  })

  test('same first-user text → same fingerprint (deterministic)', async () => {
    const build = () => makeCtx({ messages: [{ role: 'user', content: 'stable' }] })
    const a = build()
    const b = build()
    await runOnce(injectBillingBlock, a)
    await runOnce(injectBillingBlock, b)
    expect((a.payload.system as Array<{ text: string }>)[0]!.text).toBe(
      (b.payload.system as Array<{ text: string }>)[0]!.text,
    )
  })
})
