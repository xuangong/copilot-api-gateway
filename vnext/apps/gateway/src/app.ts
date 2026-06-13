import { Hono } from 'hono'
import { dataPlane } from './data-plane/routes.ts'
import { controlPlane } from './control-plane/routes.ts'
import { staticPages } from './shared/edge/static-pages.ts'
import { getRepo } from './shared/repo/index.ts'
import { devAuthMiddleware } from './shared/dev-auth.ts'
import type { ResponsesSnapshotStore } from '@vnext/responses-store'
import { createD1ResponsesStore } from './shared/runtime/responses-store-factory.ts'
import { initCache } from './shared/cache/index.ts'
import { createCacheFromEnv } from './shared/cache/factory.ts'

export interface Env {
  DB: D1Database
  KV: KVNamespace
  IMAGE_CACHE: KVNamespace
  IMAGES: ImagesBinding
  ACCOUNT_TYPE?: string
  GOOGLE_CLIENT_ID?: string
  GOOGLE_CLIENT_SECRET?: string
  CACHE_BACKEND?: 'memory' | 'kv' | 'd1'
  /** Optional override (tests inject InMemoryResponsesSnapshotStore here). */
  responsesStore?: ResponsesSnapshotStore
}

export const app = new Hono<{ Bindings: Env }>()

app.get('/health', (c) => c.json({ status: 'ok', service: 'copilot-gateway-vnext' }))

app.get('/debug/db/users-count', async (c) => {
  const users = await getRepo().users.list()
  return c.json({ users: users.length })
})

let _cacheBootstrapped = false

app.use('*', async (c, next) => {
  if (c.env && !c.env.responsesStore && c.env.DB) {
    c.env.responsesStore = createD1ResponsesStore(c.env.DB)
  }
  if (!_cacheBootstrapped && (c.env?.DB ?? c.env?.KV ?? c.env?.CACHE_BACKEND)) {
    initCache(createCacheFromEnv(
      { DB: c.env?.DB, KV: c.env?.KV },
      { CACHE_BACKEND: (c.env as Env & { CACHE_BACKEND?: string }).CACHE_BACKEND },
    ))
    _cacheBootstrapped = true
  }
  await next()
})

app.use('*', devAuthMiddleware)

app.route('/', dataPlane)
app.route('/', controlPlane)
app.route('/', staticPages)
