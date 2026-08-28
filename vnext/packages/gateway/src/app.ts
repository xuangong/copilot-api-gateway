import { Hono } from 'hono'
import { dataPlane } from './data-plane/routes.ts'
import { controlPlane } from './control-plane/routes.ts'
import { staticPages } from './shared/edge/static-pages.ts'
import { getRepo } from './repo/index.ts'
import { devAuthMiddleware } from './control-plane/auth/dev-auth.ts'
import { sessionAuthMiddleware } from './control-plane/auth/session-auth.ts'
import { dmrRouter } from './data-plane/dmr/routes.ts'
import { isDmrCompatEnabled } from './data-plane/dmr/config.ts'

export interface Env {
  ACCOUNT_TYPE?: string
  GOOGLE_CLIENT_ID?: string
  GOOGLE_CLIENT_SECRET?: string
}

export const app = new Hono<{ Bindings: Env }>()

app.use('*', async (c, next) => {
  const start = Date.now()
  await next()
  const ms = Date.now() - start
  console.log(`${c.req.method} ${new URL(c.req.url).pathname} → ${c.res.status} ${ms}ms`)
})

app.use('*', async (c, next) => {
  if (c.req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': c.req.header('origin') ?? '*',
        'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,PATCH,OPTIONS',
        'Access-Control-Allow-Headers': c.req.header('access-control-request-headers') ?? 'authorization,content-type,x-api-key,x-goog-api-key',
        'Access-Control-Max-Age': '86400',
      },
    })
  }
  await next()
  const origin = c.req.header('origin')
  if (origin) {
    c.res.headers.set('Access-Control-Allow-Origin', origin)
    c.res.headers.set('Vary', 'Origin')
  }
})

app.use('*', async (c, next) => {
  await next()
  const ct = c.res.headers.get('content-type')
  if (ct && ct.toLowerCase().startsWith('application/json') && /;\s*charset=/i.test(ct)) {
    c.res.headers.set('content-type', 'application/json')
  }
})

app.get('/health', (c) => c.json({ status: 'ok', service: 'copilot-gateway-vnext' }))

app.get('/debug/db/users-count', async (c) => {
  const users = await getRepo().users.list()
  return c.json({ users: users.length })
})

app.use('*', sessionAuthMiddleware)
app.use('*', devAuthMiddleware)

// Docker Model Runner compatibility. Inert unless DMR_COMPAT is set, in which
// case the whole data plane is re-exposed under DMR's prefixes so clients that
// hardcode them (AnythingLLM rewrites any configured base path to
// `engines/v1`) can talk to us unmodified. Mounting the router itself rather
// than aliasing routes one by one means future data-plane routes follow along
// automatically.
//
// dmrRouter must come first: its native `GET /models` returns DMR's bare-array
// shape and has to shadow the data plane's OpenAI-shaped one, and Hono matches
// in registration order. With the flag off it falls through instead of
// answering, so the shape below is unchanged.
//
// The prefixes are registered unconditionally but gated per request — the flag
// is read from the environment, and deciding at module-load time would bake in
// whatever was set when the module first happened to be imported.
//
// Prefix mounting also yields redundant combinations like
// `/engines/v1/v1/chat/completions`. Those are an artifact of stripping a
// prefix off a router that already carries `/v1` paths, not an API we mean to
// offer — harmless, and not worth extra routing to suppress.
const dmrPrefixed = new Hono<{ Bindings: Env }>()
dmrPrefixed.use('*', async (c, next) => {
  if (!isDmrCompatEnabled()) return c.notFound()
  await next()
})
dmrPrefixed.route('/', dataPlane)

app.route('/', dmrRouter)
app.route('/engines/v1', dmrPrefixed)
app.route('/engines/:engine/v1', dmrPrefixed)
app.route('/anthropic', dmrPrefixed)

// Codex model-provider compatibility namespace. Codex appends `models`,
// `responses`, `responses/compact`, `images/generations`, `images/edits` and
// `alpha/search` to whatever `model_providers.<name>.base_url` is configured,
// so every one of those has to exist under a single shared base. The data plane
// already registers each of them in both bare and `/v1` form, so mounting the
// router once puts the whole set in place.
//
// The prefix carries no routing semantics: these are the same handlers the bare
// paths use, and upstream selection still runs off the request body's `model`.
// It exists for what the string itself does to the client. Codex tests the
// endpoint against a list of Azure host substrings (`openai.azure.`,
// `cognitiveservices.azure.`, `aoai.azure.`, `azure-api.`,
// `windows.net/openai`); matching one keeps its remote-compaction path and
// makes it send `store: true`. `.codex` is only there to say what the namespace
// is for.
//
// Unconditional, unlike the DMR prefixes above: it adds paths without changing
// the behaviour of any existing one, and it reuses the same data-plane auth, so
// there is nothing to gate. It inherits the same harmless redundant
// combinations (`/azure-api.codex/v1/responses`).
app.route('/azure-api.codex', dataPlane)

app.route('/', dataPlane)
app.route('/', controlPlane)
app.route('/', staticPages)
