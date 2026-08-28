/**
 * Ollama-compatible surface (`/api/*`).
 *
 * Lets AnythingLLM (and anything else speaking ollama-js) point at this
 * gateway with base URL `http://host:41414` — no path suffix. ollama-js
 * preserves the configured pathname and appends `/api/tags`, `/api/show`,
 * `/api/chat`, `/api/embed`, so these land on the root.
 *
 * Unlike the DMR surface next door, this one is **always on and always
 * authenticated**: the Ollama client has an `Authorization` header to carry a
 * key (AnythingLLM exposes it as "Authentication Token"), so `/api/*` is
 * deliberately absent from `../dmr/config.ts`'s `isDmrPath()` and never gets
 * the env-bound identity. No credential means 401.
 *
 * Note that `/api/` is shared ground: the control plane owns `/api/keys`,
 * `/api/upstreams` and friends. Only the four exact Ollama paths are claimed
 * here, and the auth guard is per route rather than a wildcard for that reason.
 *
 * Not implemented, because AnythingLLM never calls them: `/api/generate`,
 * the legacy `/api/embeddings`, `/api/pull`, `/api/delete`, `/api/ps`,
 * `/api/version`.
 */
import { Hono, type MiddlewareHandler } from 'hono'
import type { Env } from '../../app.ts'
import type { DataPlaneAuthCtx } from '../models/routes.ts'
import { embeddingsHandler } from '../embeddings/routes.ts'
import { listTags, showModel } from './show.ts'
import { ollamaChatHandler } from './chat.ts'
import { msToNs } from './wire.ts'

type Vars = { auth: DataPlaneAuthCtx }

export const ollamaRouter = new Hono<{ Bindings: Env; Variables: Vars }>()

/**
 * Each Ollama route requires a resolved identity.
 *
 * Elsewhere in the data plane an anonymous request degrades into "no upstream
 * for that model" and surfaces as a 404. That is too indirect here: the whole
 * point of this surface is that the client *can* send a credential, so a
 * missing one deserves a 401 that points at the field the user forgot to fill
 * in. It is also the assertion that keeps the DMR env-bound key — which never
 * matches `/api/*` — from ever quietly covering for a missing token.
 *
 * Applied per route, not as a `use('/api/*')` wildcard: the *control* plane
 * also lives under `/api/` (`/api/keys`, `/api/upstreams`, …) and this router
 * is mounted ahead of it, so a wildcard here would 401 the whole admin API.
 */
const requireAuth: MiddlewareHandler<{ Bindings: Env; Variables: Vars }> = async (c, next) => {
  const auth = c.get('auth') ?? {}
  if (!auth.userId && !auth.apiKeyId) {
    return c.json({ error: 'unauthorized: set the Ollama authentication token to a gateway API key' }, 401)
  }
  await next()
}

ollamaRouter.get('/api/tags', requireAuth, async (c) => c.json(await listTags(c.get('auth') ?? {})))

ollamaRouter.post('/api/show', requireAuth, async (c) => {
  const body = await c.req.json().catch(() => null) as { model?: string; name?: string } | null
  // ollama-js sends `model`; older callers send `name`.
  const id = body?.model ?? body?.name
  if (!id) return c.json({ error: 'model is required' }, 400)
  const show = await showModel(c.get('auth') ?? {}, id)
  if (!show) return c.json({ error: `model '${id}' not found` }, 404)
  return c.json(show)
})

ollamaRouter.post('/api/chat', requireAuth, ollamaChatHandler)

/**
 * Thin shell over the OpenAI embeddings handler.
 *
 * Ollama's request differs only in that `input` may be a bare string (which
 * the OpenAI handler already normalizes) and that the response is a flat
 * `embeddings: number[][]` instead of `data: [{embedding}]`.
 */
ollamaRouter.post('/api/embed', requireAuth, async (c) => {
  const start = performance.now()
  // Clone: `embeddingsHandler` re-reads `c.req.raw` for the dump, so the
  // original body stream has to stay unconsumed here.
  const body = await c.req.raw.clone().json().catch(() => null) as
    | { model?: string; input?: string | string[] }
    | null
  if (!body || typeof body.model !== 'string') return c.json({ error: 'model is required' }, 400)
  const input = body.input ?? []

  const res = await embeddingsHandler(c, { model: body.model, input })
  if (!res.ok) return res

  const json = await res.json() as {
    data?: Array<{ embedding: number[] }>
    usage?: { prompt_tokens?: number }
  }
  const durationNs = msToNs(performance.now() - start)
  return c.json({
    model: body.model,
    embeddings: (json.data ?? []).map((d) => d.embedding),
    total_duration: durationNs,
    load_duration: durationNs,
    prompt_eval_count: json.usage?.prompt_tokens ?? 0,
  })
})
