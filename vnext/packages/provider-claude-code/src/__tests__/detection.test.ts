// Gap #1: shaped-request detection. Ported from copilot-gateway
// `packages/provider-claude-code/src/detection.ts`, whose predicate strength
// mirrors sub2api `backend/internal/service/claude_code_validator.go`.
//
// The predicate decides whether inbound /v1/messages traffic already looks like
// a real Claude Code session (pass through verbatim, keeping the caller's own
// fingerprint) or must be re-mimicked by the interceptor chain. Both directions
// of error cost plan billing, so these tests pin both.
import { describe, expect, test } from 'bun:test'
import { isClaudeCodeShapedRequest, parseMetadataUserID } from '../detection.ts'
import type { MessagesPayload } from '@vibe-llm/protocols/messages'

const LEGACY_USER_ID = `user_${'a'.repeat(64)}_account_11111111-1111-1111-1111-111111111111_session_22222222-2222-2222-2222-222222222222`

const ccHeaders = (over: Record<string, string> = {}): Headers =>
  new Headers({
    'user-agent': 'claude-cli/2.1.181 (external, cli)',
    'x-app': 'cli',
    'anthropic-beta': 'oauth-2025-04-20',
    'anthropic-version': '2023-06-01',
    ...over,
  })

const ccBody = (over: Partial<MessagesPayload> = {}): MessagesPayload =>
  ({
    model: 'claude-opus-4-6',
    max_tokens: 4096,
    messages: [{ role: 'user', content: 'hi' }],
    system: [{ type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." }],
    metadata: { user_id: LEGACY_USER_ID },
    ...over,
  }) as MessagesPayload

describe('parseMetadataUserID', () => {
  test('parses the legacy user_<sha>_account_<uuid>_session_<uuid> shape', () => {
    const parsed = parseMetadataUserID(LEGACY_USER_ID)
    expect(parsed?.isNewFormat).toBe(false)
    expect(parsed?.deviceId).toBe('a'.repeat(64))
    expect(parsed?.sessionId).toBe('22222222-2222-2222-2222-222222222222')
  })

  // sub2api deliberately accepts personal accounts that never had an
  // organization UUID, so an empty account segment is legitimate, not missing.
  test('accepts a legacy id with an empty account segment', () => {
    const parsed = parseMetadataUserID(`user_${'b'.repeat(64)}_account__session_33333333-3333-3333-3333-333333333333`)
    expect(parsed?.accountUuid).toBe('')
  })

  test('parses the CLI >= 2.1.78 JSON shape', () => {
    const parsed = parseMetadataUserID('{"device_id":"dev","account_uuid":"acc","session_id":"sess"}')
    expect(parsed).toEqual({ deviceId: 'dev', accountUuid: 'acc', sessionId: 'sess', isNewFormat: true })
  })

  test('rejects malformed JSON, missing fields, empties and junk', () => {
    expect(parseMetadataUserID('{not json')).toBeNull()
    expect(parseMetadataUserID('{"device_id":"dev"}')).toBeNull()
    expect(parseMetadataUserID('{"device_id":"","session_id":"s"}')).toBeNull()
    expect(parseMetadataUserID('')).toBeNull()
    expect(parseMetadataUserID('user_nope')).toBeNull()
  })
})

describe('isClaudeCodeShapedRequest', () => {
  test('accepts a canonical Claude Code request', () => {
    expect(isClaudeCodeShapedRequest({ headers: ccHeaders(), body: ccBody() })).toBe(true)
  })

  test('accepts a string system block carrying the billing header', () => {
    const system = 'x-anthropic-billing-header: cc_entrypoint=cli,cc_version=2.1.181'
    expect(isClaudeCodeShapedRequest({ headers: ccHeaders(), body: ccBody({ system }) })).toBe(true)
  })

  // Real CC's periodic connectivity probe: max_tokens=1 against a haiku id and
  // no system block. It short-circuits before the header/system/metadata gates.
  test('accepts the haiku connectivity probe with no system or metadata', () => {
    const body = { model: 'claude-3-5-haiku-20241022', max_tokens: 1, messages: [] } as unknown as MessagesPayload
    expect(isClaudeCodeShapedRequest({ headers: new Headers({ 'user-agent': 'claude-cli/2.1.181' }), body })).toBe(true)
  })

  // Pre-v2.1.36 clients carry no billing block but do route to plan billing.
  // Dropping the Dice fallback would re-mimic them and replace the user's real
  // session fingerprint with ours — fidelity loss for zero benefit.
  test('accepts a near-miss identity prompt via Dice bigram similarity', () => {
    const system = [{ type: 'text', text: 'You are an interactive CLI tool that helps users with software tasks' }]
    expect(isClaudeCodeShapedRequest({ headers: ccHeaders(), body: ccBody({ system }) })).toBe(true)
  })

  // Claude Code 2.1.233 added a multi-worker orchestrator mode whose identity
  // line shares only the "You are Claude Code," stem with the CLI template —
  // far enough that Dice alone misses it. Verbatim from the 2.1.233 binary.
  test('accepts the 2.1.233 orchestrator identity prompt', () => {
    const system = [
      {
        type: 'text',
        text: 'You are Claude Code, an AI assistant that orchestrates software engineering tasks across multiple workers.',
      },
    ]
    expect(isClaudeCodeShapedRequest({ headers: ccHeaders(), body: ccBody({ system }) })).toBe(true)
  })

  test('rejects a non-Claude-Code user agent', () => {
    const headers = ccHeaders({ 'user-agent': 'python-httpx/0.27.0' })
    expect(isClaudeCodeShapedRequest({ headers, body: ccBody() })).toBe(false)
  })

  test.each(['x-app', 'anthropic-beta', 'anthropic-version'])('rejects when %s is absent', (name) => {
    const headers = ccHeaders()
    headers.delete(name)
    expect(isClaudeCodeShapedRequest({ headers, body: ccBody() })).toBe(false)
  })

  test('rejects an unrelated system prompt', () => {
    const system = [{ type: 'text', text: 'Translate the following text into French.' }]
    expect(isClaudeCodeShapedRequest({ headers: ccHeaders(), body: ccBody({ system }) })).toBe(false)
  })

  test('rejects a missing system block', () => {
    const body = ccBody()
    delete (body as { system?: unknown }).system
    expect(isClaudeCodeShapedRequest({ headers: ccHeaders(), body })).toBe(false)
  })

  test('rejects a missing or unparseable metadata.user_id', () => {
    expect(isClaudeCodeShapedRequest({ headers: ccHeaders(), body: ccBody({ metadata: {} }) })).toBe(false)
    expect(isClaudeCodeShapedRequest({ headers: ccHeaders(), body: ccBody({ metadata: { user_id: 'junk' } }) })).toBe(false)
    const body = ccBody()
    delete (body as { metadata?: unknown }).metadata
    expect(isClaudeCodeShapedRequest({ headers: ccHeaders(), body })).toBe(false)
  })

  // Hand-crafted payloads can land here with structured system blocks whose
  // `.text` is missing or non-string. A TypeError would crash the inbound
  // request before any upstream call, so the extractor must skip them.
  test('survives structured system blocks with no usable text', () => {
    const system = [{ type: 'image' }, { type: 'text', text: 42 }, null, 'raw']
    expect(isClaudeCodeShapedRequest({ headers: ccHeaders(), body: ccBody({ system }) })).toBe(false)
  })
})
