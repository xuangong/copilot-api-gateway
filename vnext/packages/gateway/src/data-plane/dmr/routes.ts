/**
 * Docker Model Runner native surface (`/models*`).
 *
 * DMR exposes two families of model metadata: the OpenAI-shaped catalog under
 * `/engines/v1/models`, and its own native one at the root. They are not the
 * same shape — the native one is a *bare array* of blob descriptors, which is
 * what AnythingLLM's model picker reads. Getting it wrong is silent: its
 * `data?.forEach` throws inside a try/catch and the picker quietly falls back
 * to listing Docker Hub, so the user sees a dropdown with none of our models
 * and no error anywhere.
 *
 * Shape verified against docker/model-runner `pkg/inference/models/api.go`
 * (`Model` struct) and against the consumer in AnythingLLM's
 * `server/utils/AiProviders/dockerModelRunner/index.js`.
 *
 * Only mounted when `DMR_COMPAT` is set — see ./config.ts.
 */
import { Hono, type Handler } from 'hono'
import type { Env } from '../../app.ts'
import { listUpstreamModels } from '../providers/registry.ts'
import { isChatModel, type DataPlaneAuthCtx, type OpenAIShapedModel } from '../models/routes.ts'
import { isDmrCompatEnabled } from './config.ts'

type Vars = { auth: DataPlaneAuthCtx }

interface DmrModel {
  id: string
  tags: string[]
  created: number
  config: {
    format: string
    quantization: string
    parameters: string
    architecture: string
    size: string
    capabilities: string
    gguf: Record<string, string>
  }
}

/**
 * The capability words AnythingLLM looks for.
 *
 * `getModelCapabilities()` fetches `/models/{id}` and runs regexes over the
 * **raw response text** — `/tools|tool|tool_use|tool_call/`,
 * `/thinking|reason|reasoning|think/`, `/diffusion/`, `/vision|vllm|image/`.
 * There is no structured field it reads, so the words have to literally be in
 * the body. They are emitted from the upstream's real `capabilities.supports`
 * rather than blanket-listed: claiming vision on a text-only model makes
 * AnythingLLM attach images that the upstream then rejects.
 *
 * The rest of the payload is deliberately kept free of those substrings so a
 * model only advertises what it actually has.
 */
function capabilityWords(m: OpenAIShapedModel): string {
  const s = m.capabilities?.supports ?? {}
  const words: string[] = []
  if (s.tool_calls) words.push('tool_calls')
  if (s.vision) words.push('vision')
  if (s.adaptive_thinking || (s.reasoning_effort?.length ?? 0) > 0) words.push('reasoning')
  return words.join(' ')
}

function toDmrModel(m: OpenAIShapedModel): DmrModel {
  const limits = m.capabilities?.limits ?? {}
  const contextLength = limits.max_prompt_tokens ?? limits.max_context_window_tokens
  return {
    id: m.id,
    // AnythingLLM takes `tags.at(0)` as the model id and sends it straight back
    // in the `model` field, so this must be our own id verbatim — no `ai/` org
    // prefix, no `:latest` tag. It splits on `/` and `:` and, finding neither,
    // lands on org = the whole id and tag = "latest".
    tags: [m.id],
    // Real DMR reports the blob's creation time. We have no such thing; a fixed
    // 0 is honest about that and keeps responses byte-stable across requests.
    created: 0,
    config: {
      format: 'remote',
      quantization: 'none',
      parameters: 'n/a',
      architecture: m.name ?? m.id,
      size: 'n/a',
      capabilities: capabilityWords(m),
      gguf: {
        'general.basename': m.name ?? m.id,
        ...(contextLength !== undefined ? { 'general.context_length': String(contextLength) } : {}),
      },
    },
  }
}

async function listDmrModels(auth: DataPlaneAuthCtx): Promise<DmrModel[]> {
  const list = await listUpstreamModels({ ownerId: auth.userId, copilot: auth.copilot })
  return (list.data as unknown as OpenAIShapedModel[]).filter(isChatModel).map(toDmrModel)
}

export const dmrRouter = new Hono<{ Bindings: Env; Variables: Vars }>()

/**
 * Wraps a handler so it only runs while the compat layer is on.
 *
 * The flag is read per request rather than at mount time, and a disabled
 * request calls `next()` instead of answering. That fall-through is what keeps
 * the root `GET /models` honest: with DMR off, the data plane's own
 * OpenAI-shaped handler — registered after this one — answers it as before.
 */
const whenEnabled = (handler: Handler): Handler => (c, next) =>
  isDmrCompatEnabled() ? handler(c, next) : next()

// Bare array, not `{object,data}`. This route shadows the data plane's own
// `GET /models`, which is why app.ts mounts dmrRouter first.
dmrRouter.get('/models', whenEnabled(async (c) => c.json(await listDmrModels(c.get('auth') ?? {}))))

/**
 * 501, not 404, for the parts of DMR we deliberately don't implement.
 *
 * A gateway has no local model weights to pull or delete, and no legacy
 * completions endpoint. 404 would read as "wrong URL" and send someone
 * hunting through their base-path config; 501 says the route exists and the
 * operation doesn't.
 */
const notImplemented = (what: string): Handler =>
  whenEnabled((c) =>
    c.json(
      { error: { type: 'not_implemented', message: `${what} is not supported by this gateway.` } },
      501,
    ),
  )

dmrRouter.post('/models/create', notImplemented('Pulling models'))
dmrRouter.post('/engines/v1/completions', notImplemented('The legacy completions endpoint'))
dmrRouter.delete('/models/*', notImplemented('Deleting models'))

// Catch-all last so `/models/create` above wins. `{.+}` so multi-segment ids
// (`ai/qwen3:latest`) match as one param — real DMR ids are namespaced, and a
// client may echo one back at us.
dmrRouter.get('/models/:id{.+}', whenEnabled(async (c) => {
  const id = c.req.param('id')
  const match = (await listDmrModels(c.get('auth') ?? {})).find((m) => m.id === id)
  if (!match) {
    return c.json({ error: { type: 'not_found', message: `Model not found: ${id}` } }, 404)
  }
  return c.json(match)
}))
