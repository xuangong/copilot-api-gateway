import { test, expect } from 'bun:test'
import { app } from '../src/app.ts'

const SCAFFOLDS = [
  '/api/upstreams/_health',
  '/api/keys/_health',
  '/api/observability-shares/_health',
  '/api/auth/_health',
  '/api/upstream-accounts/_health',
]

test.each(SCAFFOLDS)('control-plane scaffold %s returns 200', async (path) => {
  const res = await app.request(path)
  expect(res.status).toBe(200)
  const body = await res.json() as { status: string }
  expect(body.status).toBe('scaffold')
})
