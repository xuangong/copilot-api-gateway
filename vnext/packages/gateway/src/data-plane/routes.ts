/**
 * Data-plane routes — Hono mount + auth bridge.
 *
 * Each chat-flow endpoint lives under `chat-flow/<endpoint>/{http,serve,attempt,respond}.ts`
 * (responses also has snapshot-sidecar.ts + image-generation-shortcut.ts;
 * messages has web-search-shortcut.ts). The per-endpoint `serve.ts` modules
 * orchestrate their own attempt → respond pipeline; there is no shared
 * dispatch module.
 */
import { Hono } from 'hono'
import type { Env } from '../app.ts'
import { modelsRouter, type DataPlaneAuthCtx } from './models/routes.ts'
import { embeddingsRouter } from './embeddings/routes.ts'
import { imagesRouter } from './images/routes.ts'
import { messagesHandler } from './chat-flow/messages/http.ts'
import { chatCompletionsHandler } from './chat-flow/chat-completions/http.ts'
import { responsesHandler } from './chat-flow/responses/http.ts'
import { geminiHandler } from './chat-flow/gemini/http.ts'
import { countTokensHandler } from './chat-flow/count-tokens/http.ts'

export const dataPlane = new Hono<{ Bindings: Env }>()

// Auth bridge — populated by future auth middleware; defaults to empty so
// downstream routers can read c.get('auth') without nullish surprises.
dataPlane.use('*', async (c, next) => {
  if (!c.get('auth' as never)) {
    c.set('auth' as never, {} as DataPlaneAuthCtx)
  }
  await next()
})

dataPlane.route('/', modelsRouter)
dataPlane.route('/', embeddingsRouter)
dataPlane.route('/', imagesRouter)

dataPlane.post('/v1/messages', messagesHandler)
dataPlane.post('/v1/messages/count_tokens', countTokensHandler)
dataPlane.post('/v1/chat/completions', chatCompletionsHandler)
dataPlane.post('/chat/completions', chatCompletionsHandler)
dataPlane.post('/v1/responses', responsesHandler)
dataPlane.post('/responses', responsesHandler)
dataPlane.post('/v1beta/models/:model{.+}', geminiHandler)
