import { Hono } from 'hono'
import { dataPlane } from './data-plane/routes.ts'
import { controlPlane } from './control-plane/routes.ts'

export interface Env {
  DB: D1Database
  KV: KVNamespace
  IMAGE_CACHE: KVNamespace
  IMAGES: ImagesBinding
  ACCOUNT_TYPE?: string
}

export const app = new Hono<{ Bindings: Env }>()

app.get('/health', (c) => c.json({ status: 'ok', service: 'copilot-gateway-vnext' }))

app.get('/debug/db/users-count', async (c) => {
  const row = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>()
  return c.json({ users: row?.n ?? null })
})

app.route('/', dataPlane)
app.route('/', controlPlane)
