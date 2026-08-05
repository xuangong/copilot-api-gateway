import { describe, expect, test } from 'bun:test'
import { injectDefaultTemplate } from '../inject-default-template'
import { DEFAULT_TEMPLATE_BLOCK } from '../system-blocks'
import { makeCtx, runOnce } from './helpers'
import type { MessagesPayload } from '@vibe-llm/protocols/messages'

const eph = { type: 'ephemeral' as const, ttl: '5m' as const }

describe('injectDefaultTemplate', () => {
  test('0 caller breakpoints → template retains cache_control', async () => {
    const ctx = makeCtx({
      system: [
        { type: 'text', text: 'billing' },
        { type: 'text', text: 'identity' },
      ],
      messages: [{ role: 'user', content: 'x' }],
    })
    await runOnce(injectDefaultTemplate, ctx)
    const system = ctx.payload.system as Array<{ type: string; text: string; cache_control?: unknown }>
    expect(system).toHaveLength(3)
    expect(system[2]).toEqual(DEFAULT_TEMPLATE_BLOCK)
    expect(system[2]!.cache_control).toBeDefined()
  })

  test('4 caller breakpoints → template demoted (no cache_control)', async () => {
    const ctx = makeCtx({
      system: [
        { type: 'text', text: 'billing', cache_control: eph },
        { type: 'text', text: 'identity', cache_control: eph },
      ],
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'a', cache_control: eph },
            { type: 'text', text: 'b', cache_control: eph },
          ],
        },
      ],
    } as Partial<MessagesPayload> & { messages: MessagesPayload['messages'] })
    await runOnce(injectDefaultTemplate, ctx)
    const system = ctx.payload.system as Array<{ type: string; text: string; cache_control?: unknown }>
    expect(system).toHaveLength(3)
    expect(system[2]!.text).toBe(DEFAULT_TEMPLATE_BLOCK.text)
    expect(system[2]!.cache_control).toBeUndefined()
  })

  test('breakpoints on tools count toward cap', async () => {
    const ctx = makeCtx({
      system: [{ type: 'text', text: 'billing' }],
      messages: [{ role: 'user', content: 'x' }],
      tools: [
        // 4 tools each with cache_control → cap hit
        { name: 't1', cache_control: eph },
        { name: 't2', cache_control: eph },
        { name: 't3', cache_control: eph },
        { name: 't4', cache_control: eph },
      ],
    } as Partial<MessagesPayload> & { messages: MessagesPayload['messages'] })
    await runOnce(injectDefaultTemplate, ctx)
    const system = ctx.payload.system as Array<{ cache_control?: unknown }>
    expect(system[system.length - 1]!.cache_control).toBeUndefined()
  })

  test('throws when system is not an array (billing must run first)', async () => {
    const ctx = makeCtx({ messages: [{ role: 'user', content: 'x' }] })
    // system is undefined here
    await expect(runOnce(injectDefaultTemplate, ctx)).rejects.toThrow(
      /inject-billing-block must run first/,
    )
  })
})
