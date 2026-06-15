import { test, expect, beforeEach } from 'bun:test'
import {
  __resetPlatformForTests,
  initRuntimeLocation,
  getRuntimeLocation,
} from '@vnext/platform'

beforeEach(() => __resetPlatformForTests())

test('getRuntimeLocation throws when not initialized', () => {
  expect(() => getRuntimeLocation()).toThrow(/not initialized/i)
})

test('initRuntimeLocation("bun") makes getRuntimeLocation return "bun"', () => {
  initRuntimeLocation('bun')
  expect(getRuntimeLocation()).toBe('bun')
})

test('initRuntimeLocation("cloudflare") makes getRuntimeLocation return "cloudflare"', () => {
  initRuntimeLocation('cloudflare')
  expect(getRuntimeLocation()).toBe('cloudflare')
})

test('reset clears the runtime location', () => {
  initRuntimeLocation('bun')
  __resetPlatformForTests()
  expect(() => getRuntimeLocation()).toThrow()
})
