import { expect, test } from 'bun:test'
import { withDefaultInstructions } from '../interceptors/responses/with-default-instructions'
import { withSystemRewrittenToDeveloper } from '../interceptors/responses/with-system-rewritten-to-developer'
import { withUnsupportedFieldsStripped } from '../interceptors/responses/with-unsupported-fields-stripped'
import type { Invocation, RequestContext } from '@vibe-llm/protocols/common'

const mkInv = (payload: Record<string, unknown>): Invocation => ({
  endpoint: 'responses',
  enabledFlags: new Set<string>(),
  payload,
  headers: {},
})

const ctx: RequestContext = { requestStartedAt: 0 }
const noop = async () => new Response(null)

test('withDefaultInstructions injects neutral value when missing', async () => {
  const inv = mkInv({ model: 'gpt-5' })
  await withDefaultInstructions(inv, ctx, noop)
  expect(inv.payload.instructions).toBe("You're a helpful assistant.")
})

test('withDefaultInstructions injects on empty string / null', async () => {
  const invEmpty = mkInv({ instructions: '' })
  await withDefaultInstructions(invEmpty, ctx, noop)
  expect(invEmpty.payload.instructions).toBe("You're a helpful assistant.")

  const invNull = mkInv({ instructions: null })
  await withDefaultInstructions(invNull, ctx, noop)
  expect(invNull.payload.instructions).toBe("You're a helpful assistant.")
})

test('withDefaultInstructions leaves non-empty user value alone', async () => {
  const inv = mkInv({ instructions: 'You are a pirate.' })
  await withDefaultInstructions(inv, ctx, noop)
  expect(inv.payload.instructions).toBe('You are a pirate.')
})

// The real Codex CLI never puts a `system` role on the Responses Lite wire —
// its base prompt rides in `instructions` and everything else is a `developer`
// item. Forwarding an inbound `system` item verbatim would emit a shape the
// client we impersonate cannot produce.
// https://github.com/openai/codex/blob/1f17e7512f0e47625f2cad416f14870688a99814/codex-rs/core/src/client.rs#L829-L849
test('withSystemRewrittenToDeveloper rewrites system input items to developer', async () => {
  const inv = mkInv({
    input: [
      { type: 'message', role: 'system', content: 'be terse' },
      { type: 'message', role: 'user', content: 'hi' },
    ],
  })
  await withSystemRewrittenToDeveloper(inv, ctx, noop)
  expect(inv.payload.input).toEqual([
    { type: 'message', role: 'developer', content: 'be terse' },
    { type: 'message', role: 'user', content: 'hi' },
  ])
})

test('withSystemRewrittenToDeveloper leaves other roles and non-array input alone', async () => {
  const inv = mkInv({ input: [{ type: 'message', role: 'developer', content: 'x' }] })
  await withSystemRewrittenToDeveloper(inv, ctx, noop)
  expect(inv.payload.input).toEqual([{ type: 'message', role: 'developer', content: 'x' }])

  // Responses accepts a bare string for `input`; it carries no role to rewrite.
  const invString = mkInv({ input: 'hi' })
  await withSystemRewrittenToDeveloper(invString, ctx, noop)
  expect(invString.payload.input).toBe('hi')
})

test('withUnsupportedFieldsStripped removes codex-rejected fields', async () => {
  const inv = mkInv({
    model: 'gpt-5',
    temperature: 0.7,
    top_p: 0.9,
    max_output_tokens: 500,
    frequency_penalty: 0.1,
    presence_penalty: 0.1,
    user: 'u1',
    metadata: { k: 'v' },
    prompt_cache_retention: '24h',
    safety_identifier: 'sid',
    stream_options: { include_usage: true },
    instructions: 'keep me',
    input: [],
  })
  await withUnsupportedFieldsStripped(inv, ctx, noop)
  expect(inv.payload).toEqual({ model: 'gpt-5', instructions: 'keep me', input: [] })
})

test('withUnsupportedFieldsStripped is a no-op when nothing to strip', async () => {
  const inv = mkInv({ model: 'gpt-5', instructions: 'x', input: [] })
  await withUnsupportedFieldsStripped(inv, ctx, noop)
  expect(inv.payload).toEqual({ model: 'gpt-5', instructions: 'x', input: [] })
})
