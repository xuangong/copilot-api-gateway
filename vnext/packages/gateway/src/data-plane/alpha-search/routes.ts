/**
 * Codex `/alpha/search` compatibility endpoint. Ported from the reference
 * project (`copilot-gateway/data-plane/alpha-search/routes.ts`).
 *
 * Two modes:
 *   - passthrough (the caller's key names an upstream + model):
 *     dispatches to the pinned codex/custom upstream and relays the raw
 *     Response verbatim (opaque `encrypted_output` preserved).
 *   - local (default): validates commands against the local
 *     search_query/open/find subset via `assertLocalWebSearchSupport`, then
 *     renders `{ encrypted_output: null, output: <text> }` through the
 *     shared web-search operations engine.
 *
 * vNext delta vs reference: no `@hono/zod-validator` middleware — inline
 * `safeParse` keeps the dependency graph flat. No upstream scope check —
 * vNext auth ctx doesn't carry `effectiveUpstreamIds` yet; when it does, the
 * check can be added in one place. See H2 plan §3–4.
 */
import type { Context } from 'hono'
import { z } from 'zod'
import type { Env } from '../../app.ts'
import type { ApiKeyId } from '../../repo/branded-ids.ts'
import { getRepo } from '../../repo/index.ts'
import { readAuth } from '../chat-flow/shared/gateway-ctx.ts'
import { providerNameFor } from '../tools/web-search/key-config.ts'
import { resolveWebSearchForKey } from '../tools/web-search/resolve-for-key.ts'
import type { ConfiguredWebSearchProvider } from '../tools/web-search/types.ts'
import {
  assertLocalWebSearchSupport,
  executeOperationToText,
  maxResultsForContextSize,
  parseWebSearchOperations,
  startBatchFetch,
  UnsupportedLocalWebSearchFeatureError,
  type WebSearchExecutionSession,
  type WebSearchFilters,
} from '../tools/web-search/operations.ts'
import { relayFetchedResponse } from '../tools/web-search/alpha-search/relay-response.ts'
import { resolveAlphaSearchDispatcher } from '../tools/web-search/alpha-search/upstream.ts'

const domainListSchema = z.array(z.string())

// Loose to preserve every OpenAI SearchSettings field for passthrough while
// letting local mode consume only what it implements.
// https://github.com/openai/codex/blob/2f19a57704fb7b1db032bc38cf995034254eaebb/codex-rs/codex-api/src/search.rs#L215-L295
const searchSettingsSchema = z.looseObject({
  filters: z
    .looseObject({
      allowed_domains: domainListSchema.optional(),
      blocked_domains: domainListSchema.optional(),
    })
    .optional(),
  user_location: z
    .looseObject({
      type: z.literal('approximate').optional(),
      city: z.string().optional(),
      region: z.string().optional(),
      country: z.string().optional(),
      timezone: z.string().optional(),
    })
    .optional(),
  search_context_size: z.enum(['low', 'medium', 'high']).optional(),
  image_settings: z
    .looseObject({
      max_results: z.number().int().nonnegative().optional(),
      caption: z.boolean().optional(),
    })
    .optional(),
  allowed_callers: z.array(z.enum(['direct', 'shell', 'code_interpreter'])).optional(),
  external_web_access: z.union([z.boolean(), z.enum(['cached', 'indexed', 'live'])]).optional(),
})

const alphaSearchRequestSchema = z.looseObject({
  commands: z.looseObject({}).optional(),
  settings: searchSettingsSchema.optional(),
})

type AlphaSearchRequest = z.infer<typeof alphaSearchRequestSchema>

const filtersFromSettings = (settings: AlphaSearchRequest['settings']): WebSearchFilters => {
  const filters: WebSearchFilters = {
    maxResults: maxResultsForContextSize(settings?.search_context_size),
  }
  if (settings?.filters?.allowed_domains) filters.allowedDomains = settings.filters.allowed_domains
  if (settings?.filters?.blocked_domains) filters.blockedDomains = settings.filters.blocked_domains
  const loc = settings?.user_location
  if (loc && (loc.city !== undefined || loc.region !== undefined || loc.country !== undefined || loc.timezone !== undefined)) {
    filters.userLocation = {
      ...(loc.city !== undefined ? { city: loc.city } : {}),
      ...(loc.region !== undefined ? { region: loc.region } : {}),
      ...(loc.country !== undefined ? { country: loc.country } : {}),
      ...(loc.timezone !== undefined ? { timezone: loc.timezone } : {}),
    }
  }
  return filters
}

export const alphaSearchHandler = async (c: Context<{ Bindings: Env }>): Promise<Response> => {
  let raw: unknown
  try {
    raw = await c.req.json()
  } catch {
    return c.json({ error: { message: 'Invalid JSON body' } }, 400)
  }
  const parsedBody = alphaSearchRequestSchema.safeParse(raw)
  if (!parsedBody.success) {
    return c.json({ error: { message: 'Invalid alpha_search request', issues: parsedBody.error.issues } }, 400)
  }
  const body = parsedBody.data

  const auth = readAuth(c)
  // Passthrough is configured on the key, like the engines: it names an
  // upstream, and upstreams are owner-scoped. Both fields set means relay;
  // otherwise the search runs locally on this key's own engines.
  const callerKey = auth.apiKeyId
    ? await getRepo().apiKeys.getById(auth.apiKeyId as ApiKeyId).catch(() => null)
    : null
  const passthroughUpstream = callerKey?.webSearchPassthroughUpstream ?? ''
  const passthroughModel = callerKey?.webSearchPassthroughModel ?? ''

  if (passthroughUpstream !== '' && passthroughModel !== '') {
    const dispatcher = await resolveAlphaSearchDispatcher({
      config: { upstreamId: passthroughUpstream, model: passthroughModel },
      auth,
    })
    const headers = new Headers()
    const turnMetadata = c.req.header('x-codex-turn-metadata')
    if (turnMetadata !== undefined) headers.set('x-codex-turn-metadata', turnMetadata)
    const response = await dispatcher(body as Record<string, unknown>, c.req.raw.signal, headers)
    return relayFetchedResponse(response)
  }

  try {
    assertLocalWebSearchSupport((body.commands ?? {}) as Record<string, unknown>)
  } catch (error) {
    if (error instanceof UnsupportedLocalWebSearchFeatureError) {
      return c.json({ encrypted_output: null, output: error.message })
    }
    throw error
  }

  const parsed = parseWebSearchOperations((body.commands ?? {}) as Record<string, unknown>)
  if (parsed.kind !== 'ops' || parsed.ops.length === 0) {
    return c.json({
      encrypted_output: null,
      output: 'No web search commands were provided. Populate at least one of `search_query`, `open`, or `find`.',
    })
  }

  // Same source of truth as the chat shims: the caller's own key. A key that
  // can't search gets the endpoint's ordinary "here is why nothing happened"
  // shape rather than a 500 — Codex renders `output` to the user.
  const resolvedSearch = await resolveWebSearchForKey(auth.apiKeyId as ApiKeyId | undefined)
  if (resolvedSearch.type !== 'enabled') {
    return c.json({
      encrypted_output: null,
      output: resolvedSearch.type === 'disabled'
        ? 'Web search is not enabled for this API key. Turn it on under API Keys in the dashboard.'
        : 'No web search engine is configured for this API key. Add a credential under API Keys in the dashboard.',
    })
  }
  const configuredProvider: Promise<ConfiguredWebSearchProvider> = Promise.resolve({
    type: 'enabled',
    provider: providerNameFor(resolvedSearch.engines[0]!),
    impl: resolvedSearch.impl,
  })

  const session: WebSearchExecutionSession = {
    getProvider: () => configuredProvider,
    filters: filtersFromSettings(body.settings),
    apiKeyId: (auth.apiKeyId ?? ('' as ApiKeyId)),
    pageCache: new Map(),
    includeSearchActionSources: false,
    signal: c.req.raw.signal,
  }


  const batch = await startBatchFetch(parsed, session)
  const blocks = await Promise.all(parsed.ops.map((op) => executeOperationToText(op, session, batch)))

  return c.json({ encrypted_output: null, output: blocks.join('\n\n') })
}
