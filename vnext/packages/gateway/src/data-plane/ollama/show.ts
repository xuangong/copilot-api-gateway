/**
 * Ollama model catalog — `GET /api/tags` and `POST /api/show`.
 *
 * Sibling of `../dmr/routes.ts`'s `toDmrModel()`: same upstream catalog,
 * different envelope. What makes this one delicate is that AnythingLLM's
 * `cacheContextWindows()` (server/utils/AiProviders/ollama/index.js) does:
 *
 *     const showInfo = await client.show({ model: model.name })
 *     if (showInfo.capabilities.includes("embedding")) return
 *     const key = Object.keys(showInfo.model_info).find(k => k.endsWith(".context_length"))
 *
 * inside a `Promise.all`. So a missing `capabilities` array is not a cosmetic
 * gap — it throws, rejects the whole batch, and *every* model silently falls
 * back to a 4096-token context window with no error surfaced anywhere. Both
 * `capabilities` and `model_info` are therefore emitted unconditionally.
 */
import { listUpstreamModels } from '../providers/registry.ts'
import type { DataPlaneAuthCtx, OpenAIShapedModel } from '../models/routes.ts'

const EPOCH = '1970-01-01T00:00:00Z'

function modelType(m: OpenAIShapedModel): 'chat' | 'embedding' | 'image' {
  const t = m.capabilities?.type?.toLowerCase()
  if (t === 'embedding' || t === 'embeddings') return 'embedding'
  if (t === 'image' || t === 'images') return 'image'
  return 'chat'
}

/**
 * Chat *and* embedding models are listed.
 *
 * AnythingLLM's `ollamaAIModels` helper (server/utils/helpers/customModels.js)
 * does no filtering at all and feeds both the LLM dropdown and the Embedder
 * dropdown from this one response. Serving chat-only would leave the Ollama
 * embedder with nothing to select. Image models are excluded because no Ollama
 * surface can reach them.
 */
export function isOllamaListable(m: OpenAIShapedModel): boolean {
  return modelType(m) !== 'image'
}

export interface OllamaTag {
  name: string
  model: string
  modified_at: string
  size: number
  digest: string
  details: {
    parent_model: string
    format: string
    family: string
    families: string[]
    parameter_size: string
    quantization_level: string
  }
}

function toTag(m: OpenAIShapedModel): OllamaTag {
  // `name` is what AnythingLLM stores and sends back as the `model` field, so
  // it must be our id verbatim — no `:latest` suffix to strip later.
  const family = m.capabilities?.family ?? 'remote'
  return {
    name: m.id,
    model: m.id,
    modified_at: EPOCH,
    size: 0,
    digest: '',
    details: {
      parent_model: '',
      format: 'remote',
      family,
      families: [family],
      parameter_size: 'n/a',
      quantization_level: 'none',
    },
  }
}

/** The capability words Ollama publishes; AnythingLLM matches these exactly. */
function capabilities(m: OpenAIShapedModel): string[] {
  if (modelType(m) === 'embedding') return ['embedding']
  const s = m.capabilities?.supports ?? {}
  const out = ['completion']
  if (s.tool_calls) out.push('tools')
  if (s.vision) out.push('vision')
  if (s.adaptive_thinking || (s.reasoning_effort?.length ?? 0) > 0) out.push('thinking')
  return out
}

/**
 * What AnythingLLM uses when it cannot find a context length of its own. A few
 * upstream models (`gpt-41-copilot`) publish no limits at all; reporting the
 * literal 0 would be worse than saying nothing, since a zero-token window makes
 * every prompt look over budget.
 */
const FALLBACK_CONTEXT_LENGTH = 4096

export function toShow(m: OpenAIShapedModel): Record<string, unknown> {
  const limits = m.capabilities?.limits ?? {}
  // `||` rather than `??`: the upstream reports a literal 0 for some models,
  // which needs the same treatment as an absent field.
  const contextLength = limits.max_prompt_tokens
    || limits.max_context_window_tokens
    || FALLBACK_CONTEXT_LENGTH
  const family = m.capabilities?.family ?? 'remote'
  const tag = toTag(m)
  return {
    license: '',
    modelfile: '',
    parameters: '',
    template: '',
    details: tag.details,
    // The `.context_length` suffix is load-bearing: AnythingLLM finds this key
    // by suffix match and falls back to 4096 when it is absent.
    model_info: {
      'general.architecture': family,
      'general.basename': m.name ?? m.id,
      [`${family}.context_length`]: contextLength,
      ...(limits.max_output_tokens !== undefined
        ? { [`${family}.max_output_tokens`]: limits.max_output_tokens }
        : {}),
    },
    capabilities: capabilities(m),
    modified_at: EPOCH,
  }
}

async function catalog(auth: DataPlaneAuthCtx): Promise<OpenAIShapedModel[]> {
  const list = await listUpstreamModels({ ownerId: auth.userId, copilot: auth.copilot })
  return (list.data as unknown as OpenAIShapedModel[]).filter(isOllamaListable)
}

export async function listTags(auth: DataPlaneAuthCtx): Promise<{ models: OllamaTag[] }> {
  return { models: (await catalog(auth)).map(toTag) }
}

export async function showModel(
  auth: DataPlaneAuthCtx,
  id: string,
): Promise<Record<string, unknown> | null> {
  const match = (await catalog(auth)).find((m) => m.id === id)
  return match ? toShow(match) : null
}
