import { test, expect } from 'bun:test'
import { PreviousResponseNotFoundError } from '../../src/data-plane/dispatch/responses-store-bridge.ts'

test('PreviousResponseNotFoundError carries id and 400 status', () => {
  const err = new PreviousResponseNotFoundError('resp_abc')
  expect(err).toBeInstanceOf(Error)
  expect(err.responseId).toBe('resp_abc')
  expect(err.status).toBe(400)
  expect(err.message).toBe("Previous response with id 'resp_abc' not found.")
})
