/**
 * Strip Gemini tool capabilities we can't translate.
 *
 * Only `functionDeclarations` are portable to our hub protocols. Everything
 * else (googleSearch, googleSearchRetrieval, codeExecution, computerUse,
 * urlContext, fileSearch, mcpServers, googleMaps) is stripped in place; tool
 * groups that end up empty after stripping are removed, and if that drains
 * the `tools` array entirely we delete the field so translators don't see
 * `tools: []` (which some downstream shape validators reject).
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
  delete tool.googleSearch
  delete tool.googleSearchRetrieval
  delete tool.codeExecution
  delete tool.computerUse
  delete tool.urlContext
  delete tool.fileSearch
  delete tool.mcpServers
  delete tool.googleMaps
}

export const stripUnsupportedToolsFromPayload = (payload: GeminiPayloadLike): void => {
  if (!payload.tools) return
  const tools = payload.tools.filter((tool) => {
    stripToolCapabilities(tool)
    return Array.isArray(tool.functionDeclarations) && tool.functionDeclarations.length > 0
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
