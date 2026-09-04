import { test, expect } from 'bun:test'
import { withBillingAttributionStripped } from '../../../../../src/data-plane/chat-flow/messages/interceptors/with-billing-attribution-stripped'
import type { Invocation, RequestContext } from '@vibe-llm/protocols/common'
import {
  llmEventResult,
  type LlmExecuteResult,
  type TelemetryModelIdentity,
} from '@vibe-llm/protocols/common'
import { doneFrame, type ProtocolFrame } from '@vibe-core/result'
import type { MessagesStreamEvent } from '@vibe-llm/protocols/messages'

const stubIdentity: TelemetryModelIdentity = {
  incomingModel: '<unknown>',
  model: '<unknown>',
  upstream: '<unknown>',
  modelKey: '<unknown>',
  cost: null,
}

const baseCtx: RequestContext = { requestStartedAt: Date.now() }

interface InvocationOptions {
  flagOn?: boolean
}

const makeInv = (
  payload: Record<string, unknown>,
  { flagOn = true }: InvocationOptions = {},
): Invocation => ({
  endpoint: 'messages',
  enabledFlags: flagOn ? new Set(['strip-billing-attribution']) : new Set(),
  sourceApi: 'messages',
  payload,
  headers: {},
})

const okRun = (): Promise<LlmExecuteResult<ProtocolFrame<MessagesStreamEvent>>> =>
  Promise.resolve(
    llmEventResult(
      (async function* () {
        yield doneFrame()
      })(),
      stubIdentity,
    ),
  )

test('strips billing-header lines and cch hashes from a string system prompt while preserving the rest', async () => {
  const inv = makeInv({
    model: 'm',
    max_tokens: 1,
    messages: [],
    system:
      'You are a helpful assistant.\nx-anthropic-billing-header: per-turn-token\ncch=deadbeef1234;\nKeep going.',
  })

  await withBillingAttributionStripped(inv, baseCtx, okRun)

  expect((inv.payload as { system: string }).system).toBe(
    'You are a helpful assistant.\n\n\nKeep going.',
  )
})

test('strips per-block from an array-form system prompt and filters blocks that become empty', async () => {
  const inv = makeInv({
    model: 'm',
    max_tokens: 1,
    messages: [],
    system: [
      { type: 'text', text: 'You are a helpful assistant.' },
      { type: 'text', text: 'x-anthropic-billing-header: token\ncch=abcdef12345' },
      { type: 'text', text: 'Keep going. cch=99fffaa1;' },
    ],
  })

  await withBillingAttributionStripped(inv, baseCtx, okRun)

  expect((inv.payload as { system: unknown }).system).toEqual([
    { type: 'text', text: 'You are a helpful assistant.' },
    { type: 'text', text: 'Keep going.' },
  ])
})

test('deletes the system field entirely when every array block becomes empty', async () => {
  const inv = makeInv({
    model: 'm',
    max_tokens: 1,
    messages: [],
    system: [
      { type: 'text', text: 'x-anthropic-billing-header: token' },
      { type: 'text', text: 'cch=deadbeef1234;' },
    ],
  })

  await withBillingAttributionStripped(inv, baseCtx, okRun)

  expect('system' in inv.payload).toBe(false)
})

test('deletes a string system field that becomes empty after stripping', async () => {
  const inv = makeInv({
    model: 'm',
    max_tokens: 1,
    messages: [],
    system: 'x-anthropic-billing-header: token\ncch=deadbeef1234;',
  })

  await withBillingAttributionStripped(inv, baseCtx, okRun)

  expect('system' in inv.payload).toBe(false)
})

test('is a no-op when system is absent', async () => {
  const inv = makeInv({
    model: 'm',
    max_tokens: 1,
    messages: [],
  })

  await withBillingAttributionStripped(inv, baseCtx, okRun)

  expect('system' in inv.payload).toBe(false)
})

test('leaves a system prompt without billing markers untouched', async () => {
  const original =
    'You are a helpful assistant. Respond in markdown and use code fences for snippets.'
  const inv = makeInv({
    model: 'm',
    max_tokens: 1,
    messages: [],
    system: original,
  })

  await withBillingAttributionStripped(inv, baseCtx, okRun)

  expect((inv.payload as { system: string }).system).toBe(original)
})

test('leaves the billing block intact when the strip flag is off (claude-code default)', async () => {
  const system =
    'You are a helpful assistant.\nx-anthropic-billing-header: per-turn-token\ncch=deadbeef1234;\nKeep going.'
  const inv = makeInv(
    {
      model: 'm',
      max_tokens: 1,
      messages: [],
      system,
    },
    { flagOn: false },
  )

  await withBillingAttributionStripped(inv, baseCtx, okRun)

  expect((inv.payload as { system: string }).system).toBe(system)
})

test('leaves an array-form billing block intact when the strip flag is off', async () => {
  const system = [
    { type: 'text', text: 'You are a helpful assistant.' },
    { type: 'text', text: 'x-anthropic-billing-header: token\ncch=abcdef12345' },
    { type: 'text', text: 'Keep going. cch=99fffaa1;' },
  ]
  const inv = makeInv(
    {
      model: 'm',
      max_tokens: 1,
      messages: [],
      system,
    },
    { flagOn: false },
  )

  await withBillingAttributionStripped(inv, baseCtx, okRun)

  expect((inv.payload as { system: unknown }).system).toEqual(system)
})
