import { Hono } from 'hono'
import { dataPlane } from './data-plane/routes.ts'
import { controlPlane } from './control-plane/routes.ts'
import { staticPages } from './shared/edge/static-pages.ts'
import { getRepo } from './shared/repo/index.ts'
import { devAuthMiddleware } from './shared/dev-auth.ts'

export interface Env {
  DB: D1Database
  KV: KVNamespace
  IMAGE_CACHE: KVNamespace
  IMAGES: ImagesBinding
  ACCOUNT_TYPE?: string
  GOOGLE_CLIENT_ID?: string
  GOOGLE_CLIENT_SECRET?: string
}

export const app = new Hono<{ Bindings: Env }>()

app.get('/health', (c) => c.json({ status: 'ok', service: 'copilot-gateway-vnext' }))

app.get('/debug/db/users-count', async (c) => {
  const users = await getRepo().users.list()
  return c.json({ users: users.length })
})

app.use('*', devAuthMiddleware)

app.route('/', dataPlane)
app.route('/', controlPlane)
app.route('/', staticPages)
