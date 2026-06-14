// vnext/apps/gateway/tests/errors/repackage-previous-id.test.ts
import { test, expect } from 'bun:test'
import { PreviousResponseNotFoundError } from '../../src/data-plane/dispatch/responses-store-bridge.ts'
import { renderPreviousResponseNotFound } from '../../src/data-plane/errors/repackage.ts'

test('renderPreviousResponseNotFound emits OpenAI verbatim 400 envelope', async () => {
  const res = renderPreviousResponseNotFound(new PreviousResponseNotFoundError('resp_abc'))
  expect(res.status).toBe(400)
  expect(res.headers.get('content-type')).toContain('application/json')
  const body = await res.json() as { error: { message: string; type: string; param: string; code: string } }
  expect(body).toEqual({
    error: {
      message: "Previous response with id 'resp_abc' not found.",
      type: 'invalid_request_error',
      param: 'previous_response_id',
      code: 'previous_response_not_found',
    },
  })
})
