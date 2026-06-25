import { test, expect } from 'bun:test'
import { diffJsonBody, diffHeaders, type DiffRules } from './diff'

const CONTROL_PLANE_RULES: DiffRules = {
  ignoreKeys: new Set(['id', 'createdAt']),
  headerAllowlist: new Set(['content-type']),
  strongEnumKeys: new Set(['kind', 'role']),
}

test('diffJsonBody respects rules.ignoreKeys (control-plane shape)', () => {
  const r = diffJsonBody(
    { id: 'a', kind: 'copilot', createdAt: '2026-01-01' },
    { id: 'b', kind: 'copilot', createdAt: '2026-12-31' },
    CONTROL_PLANE_RULES,
  )
  expect(r).toHaveLength(0)
})

test('diffJsonBody flags strong-enum mismatch even when value differs', () => {
  const r = diffJsonBody(
    { kind: 'copilot' },
    { kind: 'azure' },
    CONTROL_PLANE_RULES,
  )
  expect(r.length).toBeGreaterThan(0)
  expect(r[0].label).toBe('behavior-gap')
})

test('diffHeaders honors per-rules allowlist', () => {
  const r = diffHeaders(
    { 'content-type': 'application/json', 'x-foo': 'a' },
    { 'content-type': 'application/json', 'x-foo': 'b' },
    CONTROL_PLANE_RULES,
  )
  expect(r).toHaveLength(0)
})
