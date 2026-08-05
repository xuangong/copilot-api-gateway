import { describe, expect, test } from 'bun:test'
import { CLAUDE_CODE_MESSAGES_BOUNDARY } from '../index'
import { DEFAULT_TEMPLATE_BLOCK, IDENTITY_BLOCK } from '../system-blocks'
import { CLAUDE_CLI_VERSION } from '../../../headers'
import { makeCtx } from './helpers'
import { runInterceptors } from '@vibe-core/service'
import type { MessagesBoundaryCtx } from '../types'

describe('CLAUDE_CODE_MESSAGES_BOUNDARY (integration)', () => {
  test('full chain: small caller payload → three-block system + hoisted messages + metadata', async () => {
    const ctx = makeCtx({
      model: 'claude-sonnet-4-5',
      system: 'you are helpful',
      messages: [{ role: 'user', content: 'hello!' }],
    })
    // Strip max_tokens to test backfill
    // @ts-expect-error test
    delete ctx.payload.max_tokens

    const terminalResp = new Response('terminal-ran')
    const terminal = async () => terminalResp
    const result = await runInterceptors<MessagesBoundaryCtx, object, Response>(
      {},
      ctx,
      CLAUDE_CODE_MESSAGES_BOUNDARY,
      terminal,
    )
    expect(await result.text()).toBe('terminal-ran')

    // backfill
    expect(ctx.payload.max_tokens).toBe(8192)
    expect(ctx.payload.temperature).toBe(1)

    // metadata.user_id JSON envelope
    const metadata = ctx.payload.metadata as { user_id: string }
    expect(metadata.user_id).toBeDefined()
    const uid = JSON.parse(metadata.user_id) as { device_id: string; session_id: string; account_uuid: string }
    expect(uid.device_id).toMatch(/^[0-9a-f]{64}$/)
    expect(uid.account_uuid).toBe('')

    // three-block system
    const system = ctx.payload.system as Array<{ type: string; text: string; cache_control?: unknown }>
    expect(system).toHaveLength(3)
    const billingRe = new RegExp(
      `^x-anthropic-billing-header: cc_version=${CLAUDE_CLI_VERSION.replace(/\./g, '\\.')}\\.[0-9a-f]{3}; cc_entrypoint=cli; cch=00000;$`,
    )
    expect(system[0]!.text).toMatch(billingRe)
    expect(system[1]).toEqual(IDENTITY_BLOCK)
    expect(system[2]!.text).toBe(DEFAULT_TEMPLATE_BLOCK.text)
    expect(system[2]!.cache_control).toBeDefined()

    // hoisted synthetic user/assistant pair prepended
    expect(ctx.payload.messages).toHaveLength(3)
    expect(ctx.payload.messages[0]!.role).toBe('user')
    expect(ctx.payload.messages[1]!.role).toBe('assistant')
    expect(ctx.payload.messages[2]).toEqual({ role: 'user', content: 'hello!' })
    const firstContent = ctx.payload.messages[0]!.content as Array<{ text: string }>
    expect(firstContent[0]!.text).toBe('[System Instructions]\nyou are helpful')
  })

  test('no system → chain still yields three-block system + no synthetic pair', async () => {
    const ctx = makeCtx({
      messages: [{ role: 'user', content: 'ping' }],
    })
    await runInterceptors<MessagesBoundaryCtx, object, Response>(
      {},
      ctx,
      CLAUDE_CODE_MESSAGES_BOUNDARY,
      async () => new Response('ok'),
    )
    const system = ctx.payload.system as Array<{ text: string }>
    expect(system).toHaveLength(3)
    expect(ctx.payload.messages).toHaveLength(1)
  })
})
