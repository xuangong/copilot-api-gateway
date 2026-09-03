import { expect, test } from 'bun:test'
import { parseModelRouting } from '../../../src/data-plane/routing/model-routing.ts'

test('pure model routing parser extracts only up-prefixed pins', () => {
  expect(parseModelRouting('up_123/a')).toEqual({ upstreamPin: 'up_123', bareModel: 'a' })
  expect(parseModelRouting('vendor/a')).toEqual({ bareModel: 'vendor/a' })
  expect(parseModelRouting('a')).toEqual({ bareModel: 'a' })
})
