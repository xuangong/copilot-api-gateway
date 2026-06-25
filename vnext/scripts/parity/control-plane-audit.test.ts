import { test, expect } from 'bun:test'
import {
  CONTROL_PLANE_RULES, topoSort, resolvePlaceholders, buildAuthHeader,
  type ControlPlaneFixture,
} from './control-plane-audit'

test('CONTROL_PLANE_RULES has the spec §3 ignore set', () => {
  for (const k of ['id', 'createdAt', 'secretHash', 'ownerId', 'totalRequests']) {
    expect(CONTROL_PLANE_RULES.ignoreKeys.has(k)).toBe(true)
  }
  expect(CONTROL_PLANE_RULES.strongEnumKeys?.has('kind')).toBe(true)
})

test('topoSort orders by dependsOn and detects cycles', () => {
  const fixtures: ControlPlaneFixture[] = [
    { name: 'b', endpoint: '/x', method: 'GET', auth: 'admin-session', dependsOn: ['a'] },
    { name: 'a', endpoint: '/x', method: 'GET', auth: 'admin-session' },
  ]
  expect(topoSort(fixtures).map((f) => f.name)).toEqual(['a', 'b'])

  const cyc: ControlPlaneFixture[] = [
    { name: 'a', endpoint: '/x', method: 'GET', auth: 'admin-session', dependsOn: ['b'] },
    { name: 'b', endpoint: '/x', method: 'GET', auth: 'admin-session', dependsOn: ['a'] },
  ]
  expect(() => topoSort(cyc)).toThrow(/cycle/)
})

test('resolvePlaceholders walks ${capture.foo.bar} and ${env.X}', () => {
  const ctx = {
    captures: { 'create-key': { keyId: 'kid_1', key: 'sk_abc' } },
    env: { PARITY_TARGET_USER_ID: 'uid_target' },
  }
  expect(resolvePlaceholders('/api/keys/${capture.create-key.keyId}', ctx))
    .toBe('/api/keys/kid_1')
  expect(resolvePlaceholders({ userId: '${env.PARITY_TARGET_USER_ID}' }, ctx))
    .toEqual({ userId: 'uid_target' })
})

test('buildAuthHeader returns cookie for admin-session and bearer for api-key', () => {
  const env = {
    PARITY_ROOT_ADMIN_TOKEN: 'ses_root',
    PARITY_VNEXT_ADMIN_TOKEN: 'ses_vnext',
    PARITY_ROOT_ADMIN_API_KEY: 'sk_root',
    PARITY_VNEXT_ADMIN_API_KEY: 'sk_vnext',
  }
  expect(buildAuthHeader('admin-session', 'root', env, {}))
    .toEqual({ Cookie: 'session_token=ses_root' })
  expect(buildAuthHeader('api-key', 'vnext', env, {}))
    .toEqual({ Authorization: 'Bearer sk_vnext' })
})

test('buildAuthHeader uses fixture-scoped api-key when capture is present', () => {
  const env = { PARITY_ROOT_ADMIN_API_KEY: 'sk_root_fallback' }
  const sideKeys = { root: 'sk_root_from_capture', vnext: 'sk_vnext_from_capture' }
  expect(buildAuthHeader('api-key', 'root', env, sideKeys))
    .toEqual({ Authorization: 'Bearer sk_root_from_capture' })
})
