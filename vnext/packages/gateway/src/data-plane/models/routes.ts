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
import type { ApiKeyId, UserId } from '../../shared/repo/branded-ids.ts'
import { isCodexUserAgent } from '../codex/catalog.ts'
import { loadCodexCatalog } from '../codex/models.ts'

// Claude Code CLI (`claude-code/x.y.z (...)`) hits `/v1/models` to populate its
// `/model` picker. It expects the Anthropic-shape catalog
// (`{data:[ModelInfo,...], first_id, has_more, last_id}`), NOT OpenAI's
// `{object:'list', data:[...]}`. Additionally, Claude Code's 1M-context switch
// requires the discovered model id to itself carry a `[1m]` suffix — the CLI
// strips it before sending inference requests and pairs it with the
// `anthropic-beta: context-1m-2025-08-07` header. Any model whose
// `max_context_window_tokens >= 1_000_000` gets the suffix appended so the
// picker exposes both the standard and 1M variants under distinct ids.
//
// Reference: copilot-gateway `data-plane/models/http.ts` (`toClaudeCodeCatalog`,
// `isClaudeCodeUserAgent`). vNext delta: reference reads from a rich
// `PublicModelsResponse` (`display_name`, `created_at`, `limits.*`); vNext's
// `listUpstreamModels().data` publishes the flatter OpenAI-shape row
// (`id`, `name?`, `capabilities.limits.*`), so `display_name` falls back to
// `name ?? id` and `created_at` is stamped as the frozen unknown sentinel.
const CREATED_AT_UNKNOWN = '1970-01-01T00:00:00Z'

const isClaudeCodeUserAgent = (userAgent: string | undefined): boolean =>
  userAgent?.startsWith('claude-code/') ?? false

interface ClaudeCodeModel {
  id: string
  type: 'model'
  display_name: string
  created_at: string
  max_input_tokens: number | null
  max_tokens: number | null
  capabilities: null
}

interface ClaudeCodeCatalog {
  data: ClaudeCodeModel[]
  first_id: string | null
  has_more: false
  last_id: string | null
}

function toClaudeCodeCatalog(models: readonly OpenAIShapedModel[]): ClaudeCodeCatalog {
  const data: ClaudeCodeModel[] = models.filter(isChatModel).map((m) => {
    const limits = m.capabilities?.limits ?? {}
    const maxInput = limits.max_prompt_tokens ?? limits.max_context_window_tokens
    const suffixed = maxInput !== undefined && maxInput >= 1_000_000 ? `${m.id}[1m]` : m.id
    return {
      id: suffixed,
      type: 'model' as const,
      display_name: m.name ?? m.id,
      created_at: CREATED_AT_UNKNOWN,
      max_input_tokens: maxInput ?? null,
      max_tokens: limits.max_output_tokens ?? null,
      capabilities: null,
    }
  })
  return {
    data,
    first_id: data[0]?.id ?? null,
    has_more: false as const,
    last_id: data[data.length - 1]?.id ?? null,
  }
}

export interface DataPlaneAuthCtx {
  userId?: UserId
  copilot?: CreateProviderOptions
  /** API-key id authenticated for this request; required for per-key web-search/quota lookups. */
  apiKeyId?: ApiKeyId
  /** GitHub OAuth token attached to the request (used by Copilot web-search engine). */
  githubToken?: string
  /** Env-derived Microsoft Grounding key, surfaced via auth ctx so handlers don't reach into env directly. */
  msGroundingKey?: string
}

type Vars = { auth: DataPlaneAuthCtx }

export const modelsRouter = new Hono<{ Bindings: Env; Variables: Vars }>()

modelsRouter.get('/api/models', async (c) => {
  const auth = c.get('auth') ?? {}
  // `?dedupe=0` returns the full per-upstream mapping (same model id may appear
  // under several upstreams). SDK-facing routes below never pass this.
  const dedupe = c.req.query('dedupe') !== '0'
  return c.json(await listUpstreamModels({ ownerId: auth.userId, copilot: auth.copilot, dedupe }))
})

async function handleList(auth: DataPlaneAuthCtx) {
  const models = await listUpstreamModels({ ownerId: auth.userId, copilot: auth.copilot })
  if (!models.data.length && !auth.copilot?.copilotToken) {
    return { ok: false, models } as const
  }
  return { ok: true, models } as const
}

// Codex CLI (all originators: `codex-tui`, `codex_cli_rs`, `codex_exec`,
// Desktop, IDE) issues `/models` with a User-Agent like
// `codex-tui/0.144.1 (…)`. When we recognize that UA we serve Codex's own
// `ModelsResponse` shape (`{models: [ModelInfo,...]}`) instead of the OpenAI
// public catalog — Codex reads this shape via `OpenAiModelsManager::list_models`
// and replaces its bundled catalog when auth is Chatgpt / AgentIdentity.
// Any other UA (including OpenAI public SDKs) keeps the historic OpenAI-shape
// response so existing SDK consumers see byte-identical output.
async function handleModelsRequest(c: {
  req: { header: (name: string) => string | undefined }
  get: (key: 'auth') => DataPlaneAuthCtx | undefined
  json: (body: unknown, status?: 200 | 404) => Response
}) {
  const auth = c.get('auth') ?? {}
  const ua = c.req.header('user-agent')
  if (isClaudeCodeUserAgent(ua)) {
    const list = await listUpstreamModels({ ownerId: auth.userId, copilot: auth.copilot })
    if (!list.data.length && !auth.copilot?.copilotToken) {
      return c.json(
        { error: { type: 'invalid_request_error', message: 'GitHub token not found. Use /auth/github to connect your account.' } },
        404,
      )
    }
    return c.json(toClaudeCodeCatalog(list.data as OpenAIShapedModel[]))
  }
  if (isCodexUserAgent(ua)) {
    const list = await listUpstreamModels({ ownerId: auth.userId, copilot: auth.copilot })
    if (!list.data.length && !auth.copilot?.copilotToken) {
      return c.json(
        { error: { type: 'invalid_request_error', message: 'GitHub token not found. Use /auth/github to connect your account.' } },
        404,
      )
    }
    const catalog = await loadCodexCatalog(ua, list.data as unknown as { id: string; name?: string; capabilities?: { type?: string; limits?: { max_context_window_tokens?: number } } }[])
    return c.json(catalog)
  }
  const result = await handleList(auth)
  if (!result.ok) {
    return c.json(
      { error: { type: 'invalid_request_error', message: 'GitHub token not found. Use /auth/github to connect your account.' } },
      404,
    )
  }
  return c.json(result.models)
}

modelsRouter.get('/models', (c) => handleModelsRequest(c as never))
modelsRouter.get('/v1/models', (c) => handleModelsRequest(c as never))

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
