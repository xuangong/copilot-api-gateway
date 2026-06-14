import { test, expect } from 'bun:test'
import { detectClient } from '../../src/shared/observability/client-detect.ts'

test('detectClient: known clients', () => {
  expect(detectClient('claude-cli/1.0 (claude-code)')).toBe('claude-code')
  expect(detectClient('codex-cli/2.0')).toBe('codex-cli')
  expect(detectClient('Cursor/0.42 anthropic-typescript/0.30')).toBe('cursor')
  expect(detectClient('OpenAI/Python 1.55.0')).toBe('openai-sdk')
  expect(detectClient('python-requests/2.32')).toBe('python-requests')
})

test('detectClient: empty / null / undefined', () => {
  expect(detectClient('')).toBe('')
  expect(detectClient(null)).toBe('')
  expect(detectClient(undefined)).toBe('')
})

test('detectClient: unknown UA falls back to first product token', () => {
  expect(detectClient('MyApp/1.0 (linux)')).toBe('myapp')
  expect(detectClient('Foo-Bar.Baz/9 (etc)')).toBe('foo-bar.baz')
})

test('detectClient: claude-code Claude/ form', () => {
  expect(detectClient('Claude/1.0 (Anthropic)')).toBe('claude-code')
})
