import { describe, expect, test } from 'bun:test'
import {
  aggregateLabel,
  diffHeaders,
  diffJsonBody,
  diffSse,
  diffStatus,
  maskHeaderValue,
  parseSse,
} from './data-plane-audit'

describe('diffStatus', () => {
  test('equal status returns no diff', () => {
    expect(diffStatus(200, 200)).toEqual([])
  })
  test('different status is behavior-gap', () => {
    const d = diffStatus(200, 500)
    expect(d).toHaveLength(1)
    expect(d[0].label).toBe('behavior-gap')
    expect(d[0].layer).toBe('status')
  })
})

describe('maskHeaderValue', () => {
  test('masks uuid', () => {
    expect(maskHeaderValue('req-12345678-1234-1234-1234-1234567890ab-end'))
      .toContain('<uuid>')
  })
  test('masks port and digits', () => {
    expect(maskHeaderValue('http://127.0.0.1:4141/x/42'))
      .toMatch(/<port>|<num>/)
  })
})

describe('diffHeaders', () => {
  test('matching allowlisted headers → parity', () => {
    const r = { 'content-type': 'application/json', 'x-extra': 'noise' }
    const v = { 'content-type': 'application/json', 'x-other': 'noise' }
    expect(diffHeaders(r, v)).toEqual([])
  })
  test('different content-type → cosmetic-diff', () => {
    const r = { 'content-type': 'application/json' }
    const v = { 'content-type': 'text/plain' }
    const d = diffHeaders(r, v)
    expect(d).toHaveLength(1)
    expect(d[0].label).toBe('cosmetic-diff')
  })
  test('uuid in x-request-id masked equal → no diff', () => {
    const r = { 'x-request-id': 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }
    const v = { 'x-request-id': 'ffffffff-1111-2222-3333-444444444444' }
    expect(diffHeaders(r, v)).toEqual([])
  })
})

describe('diffJsonBody', () => {
  test('identical bodies → no diff', () => {
    const a = { model: 'm', choices: [{ message: { role: 'assistant', content: 'hi' } }] }
    const b = { model: 'm', choices: [{ message: { role: 'assistant', content: 'hi' } }] }
    expect(diffJsonBody(a, b)).toEqual([])
  })
  test('ignored fields differ → no diff', () => {
    const a = { id: 'x1', created: 1, model: 'm', system_fingerprint: 'fp_a' }
    const b = { id: 'x2', created: 9, model: 'm', system_fingerprint: 'fp_b' }
    expect(diffJsonBody(a, b)).toEqual([])
  })
  test('strong field model differs → behavior-gap', () => {
    const a = { model: 'gpt-4o-mini' }
    const b = { model: 'gpt-4o' }
    const d = diffJsonBody(a, b)
    expect(d.some((x) => x.label === 'behavior-gap' && x.detail.includes('model'))).toBe(true)
  })
  test('content non-empty on both sides → no diff (prose ignored)', () => {
    const a = { choices: [{ message: { role: 'assistant', content: 'aaaaaaaaaaa' } }] }
    const b = { choices: [{ message: { role: 'assistant', content: 'completely different prose' } }] }
    expect(diffJsonBody(a, b)).toEqual([])
  })
  test('content empty on one side → behavior-gap', () => {
    const a = { choices: [{ message: { role: 'assistant', content: 'hi' } }] }
    const b = { choices: [{ message: { role: 'assistant', content: '' } }] }
    const d = diffJsonBody(a, b)
    expect(d.some((x) => x.label === 'behavior-gap')).toBe(true)
  })
  test('usage key sets match → no diff (values ignored)', () => {
    const a = { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }
    const b = { usage: { prompt_tokens: 99, completion_tokens: 88, total_tokens: 187 } }
    expect(diffJsonBody(a, b)).toEqual([])
  })
  test('usage key missing on one side → behavior-gap', () => {
    const a = { usage: { prompt_tokens: 10, completion_tokens: 5 } }
    const b = { usage: { prompt_tokens: 10 } }
    const d = diffJsonBody(a, b)
    expect(d.some((x) => x.label === 'behavior-gap' && x.detail.includes('usage'))).toBe(true)
  })
})

describe('parseSse', () => {
  test('parses event + data blocks', () => {
    const raw = 'event: message_start\ndata: {"type":"message_start"}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"hi"}}\n\n'
    const msgs = parseSse(raw)
    expect(msgs).toHaveLength(2)
    expect(msgs[0].event).toBe('message_start')
    expect(msgs[1].kind).toBe('text')
  })
  test('classifies [DONE]', () => {
    const msgs = parseSse('data: [DONE]\n\n')
    expect(msgs[0].kind).toBe('done')
  })
})

describe('diffSse', () => {
  test('same structure different prose → parity', () => {
    const r = 'event: x\ndata: {"delta":{"text":"hello world"}}\n\n'
    const v = 'event: x\ndata: {"delta":{"text":"completely different"}}\n\n'
    expect(diffSse(r, v)).toEqual([])
  })
  test('different event sequence → behavior-gap', () => {
    const r = 'event: a\ndata: {}\n\nevent: b\ndata: {}\n\n'
    const v = 'event: a\ndata: {}\n\nevent: c\ndata: {}\n\n'
    const d = diffSse(r, v)
    expect(d.some((x) => x.label === 'behavior-gap')).toBe(true)
  })
  test('different event count → behavior-gap', () => {
    const r = 'event: a\ndata: {}\n\n'
    const v = 'event: a\ndata: {}\n\nevent: b\ndata: {}\n\n'
    const d = diffSse(r, v)
    expect(d.some((x) => x.detail.includes('event count'))).toBe(true)
  })
})

describe('aggregateLabel', () => {
  test('empty diffs → parity', () => {
    expect(aggregateLabel([])).toBe('parity')
  })
  test('only cosmetic → cosmetic-diff', () => {
    expect(aggregateLabel([{ layer: 'header', label: 'cosmetic-diff', detail: '' }])).toBe('cosmetic-diff')
  })
  test('any behavior-gap dominates', () => {
    expect(aggregateLabel([
      { layer: 'header', label: 'cosmetic-diff', detail: '' },
      { layer: 'body', label: 'behavior-gap', detail: '' },
    ])).toBe('behavior-gap')
  })
})
