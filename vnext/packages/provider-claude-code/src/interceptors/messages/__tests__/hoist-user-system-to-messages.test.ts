import { describe, expect, test } from 'bun:test'
import { hoistUserSystemToMessages } from '../hoist-user-system-to-messages'
import { makeCtx, runOnce } from './helpers'

const SYNTHETIC_ACK = 'Understood. I will follow these instructions.'

describe('hoistUserSystemToMessages', () => {
  test('folds string system into synthetic user/assistant pair', async () => {
    const ctx = makeCtx({
      system: 'be nice',
      messages: [{ role: 'user', content: 'hi' }],
    })
    await runOnce(hoistUserSystemToMessages, ctx)
    expect(ctx.payload.system).toBeUndefined()
    expect(ctx.payload.messages).toHaveLength(3)
    expect(ctx.payload.messages[0]).toEqual({
      role: 'user',
      content: [{ type: 'text', text: '[System Instructions]\nbe nice' }],
    })
    expect(ctx.payload.messages[1]).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: SYNTHETIC_ACK }],
    })
    expect(ctx.payload.messages[2]).toEqual({ role: 'user', content: 'hi' })
  })

  test('folds block-array system, joins with double newlines', async () => {
    const ctx = makeCtx({
      system: [
        { type: 'text', text: 'first' },
        { type: 'text', text: 'second' },
      ],
      messages: [{ role: 'user', content: 'hi' }],
    })
    await runOnce(hoistUserSystemToMessages, ctx)
    expect(ctx.payload.system).toBeUndefined()
    const firstMsg = ctx.payload.messages[0]! as { content: Array<{ text: string }> }
    expect(firstMsg.content[0]!.text).toBe('[System Instructions]\nfirst\n\nsecond')
  })

  test('no system → messages untouched, no synthetic pair', async () => {
    const ctx = makeCtx({ messages: [{ role: 'user', content: 'hi' }] })
    await runOnce(hoistUserSystemToMessages, ctx)
    expect(ctx.payload.system).toBeUndefined()
    expect(ctx.payload.messages).toHaveLength(1)
    expect(ctx.payload.messages[0]).toEqual({ role: 'user', content: 'hi' })
  })

  test('empty string system → no synthetic pair', async () => {
    const ctx = makeCtx({
      system: '',
      messages: [{ role: 'user', content: 'hi' }],
    })
    await runOnce(hoistUserSystemToMessages, ctx)
    expect(ctx.payload.messages).toHaveLength(1)
  })
})
