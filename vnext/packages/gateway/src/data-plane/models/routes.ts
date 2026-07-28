/**
 * Models data-plane router — Week 5a-impl port of old src/routes/models.ts.
 *
 * Three routes preserved 1:1:
 *   - GET /api/models         — dashboard endpoint; gracefully empty when no upstream
 *   - GET /models             — SDK probe; 404 JSON when empty AND no per-request copilot token
 *   - GET /v1/models          — same as /models
 *
 * vnext shape delta: old project threw `new Error("GitHub token not found...")` and let the
 * outer Elysia error mapper turn it into 5xx. vnext returns an explicit 404 JSON so the
 * client sees a stable shape; SDK consumers treat 404 the same as the old 5xx text.
 *
 * Auth context: caller-supplied via `c.get('auth')` carrying optional `userId` +
 * `copilot` ({copilotToken, accountType}); registry handles the request-scoped fallback.
 */
import { Hono } from 'hono'
import type { Env } from '../../app.ts'
import { listUpstreamModels, type CreateProviderOptions } from '../providers/registry.ts'

export interface DataPlaneAuthCtx {
  userId?: string
  copilot?: CreateProviderOptions
  /** API-key id authenticated for this request; required for per-key web-search/quota lookups. */
  apiKeyId?: string
  /** GitHub OAuth token attached to the request (used by Copilot web-search engine). */
  githubToken?: string
  /** Env-derived Microsoft Grounding key, surfaced via auth ctx so handlers don't reach into env directly. */
  msGroundingKey?: string
}

type Vars = { auth: DataPlaneAuthCtx }

export const modelsRouter = new Hono<{ Bindings: Env; Variables: Vars }>()

modelsRouter.get('/api/models', async (c) => {
  const auth = c.get('auth') ?? {}
  return c.json(await listUpstreamModels({ ownerId: auth.userId, copilot: auth.copilot }))
})

async function handleList(auth: DataPlaneAuthCtx) {
  const models = await listUpstreamModels({ ownerId: auth.userId, copilot: auth.copilot })
  if (!models.data.length && !auth.copilot?.copilotToken) {
    return { ok: false, models } as const
  }
  return { ok: true, models } as const
}

modelsRouter.get('/models', async (c) => {
  const result = await handleList(c.get('auth') ?? {})
  if (!result.ok) {
    return c.json(
      { error: { type: 'invalid_request_error', message: 'GitHub token not found. Use /auth/github to connect your account.' } },
      404,
    )
  }
  return c.json(result.models)
})

modelsRouter.get('/v1/models', async (c) => {
  const result = await handleList(c.get('auth') ?? {})
  if (!result.ok) {
    return c.json(
      { error: { type: 'invalid_request_error', message: 'GitHub token not found. Use /auth/github to connect your account.' } },
      404,
    )
  }
  return c.json(result.models)
})

// Gemini list/get: SDKs (`@google/genai`) hit `/v1beta/models` on init and
// `/v1beta/models/:modelId` to resolve default model metadata. Both return
// Gemini-shaped `{ models: [...] }` / single-model JSON. Non-chat entries
// (embeddings/images) are filtered out — Gemini's REST surface only speaks
// generate/stream/countTokens.
interface GeminiModelShape {
  name: string
  baseModelId: string
  displayName: string
  supportedGenerationMethods: readonly ['generateContent', 'streamGenerateContent', 'countTokens']
  inputTokenLimit?: number
  outputTokenLimit?: number
  temperature: 1
  topP: 0.95
  topK: 40
}

interface OpenAIShapedModel {
  id: string
  name?: string
  capabilities?: {
    type?: string
    limits?: {
      max_context_window_tokens?: number
      max_output_tokens?: number
      max_prompt_tokens?: number
    }
  }
}

function toGeminiShape(m: OpenAIShapedModel): GeminiModelShape {
  const limits = m.capabilities?.limits ?? {}
  const inputTokenLimit = limits.max_prompt_tokens ?? limits.max_context_window_tokens
  const outputTokenLimit = limits.max_output_tokens
  return {
    name: `models/${m.id}`,
    baseModelId: m.id,
    displayName: m.name ?? m.id,
    supportedGenerationMethods: ['generateContent', 'streamGenerateContent', 'countTokens'] as const,
    ...(inputTokenLimit !== undefined ? { inputTokenLimit } : {}),
    ...(outputTokenLimit !== undefined ? { outputTokenLimit } : {}),
    temperature: 1,
    topP: 0.95,
    topK: 40,
  }
}

function isChatModel(m: OpenAIShapedModel): boolean {
  const capType = m.capabilities?.type?.toLowerCase()
  // Gemini surface skips embeddings/images. Copilot rows come back with
  // type='chat'; generic providers may omit the field, so treat missing
  // type as chat too (mirrors listUpstreamModels' default).
  if (!capType) return true
  return capType !== 'embedding' && capType !== 'embeddings' && capType !== 'image' && capType !== 'images'
}

function geminiError(status: 404 | 502, message: string): Response {
  const geminiStatus = status === 404 ? 'NOT_FOUND' : 'UNAVAILABLE'
  return Response.json(
    { error: { code: status, message, status: geminiStatus } },
    { status },
  )
}

modelsRouter.get('/v1beta/models', async (c) => {
  const auth = c.get('auth') ?? {}
  const list = await listUpstreamModels({ ownerId: auth.userId, copilot: auth.copilot })
  const models = (list.data as OpenAIShapedModel[]).filter(isChatModel).map(toGeminiShape)
  return c.json({ models })
})

modelsRouter.get('/v1beta/models/:modelId{.+}', async (c) => {
  const raw = c.req.param('modelId') ?? ''
  const modelId = raw.replace(/^models\//, '')
  if (!modelId) return geminiError(404, 'Model not found: ')
  const auth = c.get('auth') ?? {}
  const list = await listUpstreamModels({ ownerId: auth.userId, copilot: auth.copilot })
  const match = (list.data as OpenAIShapedModel[])
    .filter(isChatModel)
    .find((m) => m.id === modelId)
  if (!match) return geminiError(404, `Model not found: ${modelId}`)
  return c.json(toGeminiShape(match))
})
