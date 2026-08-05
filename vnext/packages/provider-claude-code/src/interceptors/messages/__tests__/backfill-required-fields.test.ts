import { describe, expect, test } from 'bun:test'
import { backfillRequiredFields } from '../backfill-required-fields'
import { makeCtx, makeModel, runOnce } from './helpers'

describe('backfillRequiredFields', () => {
  test('fills max_tokens from model.limits.max_output_tokens when caller omits', async () => {
    const ctx = makeCtx(
      { messages: [{ role: 'user', content: 'hi' }] },
      { model: makeModel(16384) },
    )
    // @ts-expect-error strip max_tokens after cast
    delete ctx.payload.max_tokens
    await runOnce(backfillRequiredFields, ctx)
    expect(ctx.payload.max_tokens).toBe(16384)
  })

  test('fills max_tokens to 8192 fallback when no model limit and no caller value', async () => {
    const ctx = makeCtx({ messages: [{ role: 'user', content: 'hi' }] })
    // @ts-expect-error strip max_tokens
    delete ctx.payload.max_tokens
    await runOnce(backfillRequiredFields, ctx)
    expect(ctx.payload.max_tokens).toBe(8192)
  })

  test('fills temperature to 1 when caller omits', async () => {
    const ctx = makeCtx({ messages: [{ role: 'user', content: 'hi' }] })
    await runOnce(backfillRequiredFields, ctx)
    expect(ctx.payload.temperature).toBe(1)
  })

  test('preserves caller-supplied max_tokens and temperature', async () => {
    const ctx = makeCtx({
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 2048,
      temperature: 0.5,
    })
    await runOnce(backfillRequiredFields, ctx)
    expect(ctx.payload.max_tokens).toBe(2048)
    expect(ctx.payload.temperature).toBe(0.5)
  })

  test('preserves temperature=0 (falsy but explicit)', async () => {
    const ctx = makeCtx({
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0,
    })
    await runOnce(backfillRequiredFields, ctx)
    expect(ctx.payload.temperature).toBe(0)
  })
})
