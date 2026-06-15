/**
 * Data-plane routes — pairwise translation pipeline.
 *
 * Flow per request:
 *   1. frontend.parse(raw)               — Zod-validate client payload
 *   2. enumerateBindingCandidates(...)   — pick binding + target endpoint via
 *                                          source-API preference (selectPair)
 *   3. getTranslator(source, target)     — uniform PairTranslator handle
 *   4. translator.translateRequest(...)  — client payload → hub payload
 *   5. runConversationAttempt(...)       — quota gate → timer → call → record
 *   6. streaming:   parse upstream SSE → translator.translateEvents → encodeClientSSE
 *      non-stream:  translator.translateBody(json) → JSON
 *
 * No IR (intermediate representation). The messages→messages route uses the
 * identity translator (zero-cost passthrough). Other routes pay one
 * translateRequest + one translateEvents/translateBody. HTTPError surfaces
 * from binding.provider.fetch and is repackaged into the client's native
 * error wire shape.
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

// Auth bridge — populated by future auth middleware; for now defaults to empty so
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

dataPlane.post('/v1/responses', responsesHandler)

dataPlane.post('/v1beta/models/:model{.+}', geminiHandler)
