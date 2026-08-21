/**
 * Strip Gemini tool capabilities we can't translate.
 *
 * `functionDeclarations` are portable to our hub protocols, and
 * `googleSearch` / `googleSearchRetrieval` are now mapped by each
 * `gemini-via-*` request translator onto that target's hosted web search — so
 * both are left in place. Everything else (codeExecution, computerUse,
 * urlContext, fileSearch, mcpServers, googleMaps) is stripped in place; tool
 * groups that end up carrying nothing we understand are removed, and if that
 * drains the `tools` array entirely we delete the field so translators don't
 * see `tools: []` (which some downstream shape validators reject).
 *
 * Note that a search-only group (`{ googleSearch: {} }`) has no
 * `functionDeclarations` and must still survive this filter, otherwise the
 * translator never sees the request for search.
 *
 * Ported from `copilot-gateway`'s `strip-unsupported-tools.ts`.
 */
import type { GeminiInterceptor } from './types.ts'

interface GeminiToolGroupLike {
  functionDeclarations?: unknown[]
  googleSearch?: unknown
  googleSearchRetrieval?: unknown
  codeExecution?: unknown
  computerUse?: unknown
  urlContext?: unknown
  fileSearch?: unknown
  mcpServers?: unknown
  googleMaps?: unknown
  [k: string]: unknown
}

interface GeminiPayloadLike {
  tools?: GeminiToolGroupLike[]
  [k: string]: unknown
}

const stripToolCapabilities = (tool: GeminiToolGroupLike): void => {
  delete tool.codeExecution
  delete tool.computerUse
  delete tool.urlContext
  delete tool.fileSearch
  delete tool.mcpServers
  delete tool.googleMaps
}

const carriesSomethingTranslatable = (tool: GeminiToolGroupLike): boolean =>
  (Array.isArray(tool.functionDeclarations) && tool.functionDeclarations.length > 0) ||
  tool.googleSearch !== undefined ||
  tool.googleSearchRetrieval !== undefined

export const stripUnsupportedToolsFromPayload = (payload: GeminiPayloadLike): void => {
  if (!payload.tools) return
  const tools = payload.tools.filter((tool) => {
    stripToolCapabilities(tool)
    return carriesSomethingTranslatable(tool)
  })
  if (tools.length === 0) {
    delete payload.tools
  } else {
    payload.tools = tools
  }
}

export const stripUnsupportedTools: GeminiInterceptor = (ctx, _requestCtx, run) => {
  stripUnsupportedToolsFromPayload(ctx.payload as GeminiPayloadLike)
  return run()
}
