import type { ResponsesInterceptor } from './types'
import type { ResponsesTool } from '../../../orchestrator/server-tools/types.ts'
import { isHostedImageGenerationTool } from './server-tools/image-generation'

/**
 * Declare the hosted `image_generation` tool on behalf of callers that would
 * rather not repeat it on every request.
 *
 * Only useful to a caller that renders `image_generation_call` items itself —
 * i.e. one that can do something with a base64 `result`. That is an API
 * integration, not an interactive client.
 *
 * Explicitly NOT for Codex, even though its rendering gap is what prompted this
 * to be written. Codex deserializes the item and records it, but its image UI is
 * keyed on a *file path* (`ImageGenerationItem.savedPath`, written under
 * `$CODEX_HOME/generated_images/`), which only its own local Rust extension
 * produces. A spec-compliant hosted item carries base64 and no path, so nothing
 * renders. Codex is served by pointing that extension at the gateway instead —
 * see the `/azure-api.codex` mount in `app.ts`.
 *
 * Position: must run OUTSIDE `withResponsesServerToolShim`, which activates on
 * an already-declared hosted tool.
 *
 * Declaring is not forcing. `tool_choice` is left untouched, so a turn with no
 * visual intent simply never calls it. `tool_choice: 'none'` is honored by
 * skipping injection outright — declaring a tool the caller has explicitly
 * disabled would be pure prompt pollution.
 *
 * Opt-in per upstream (`responses-image-generation-inject`, `defaultFor: []`):
 * every injected tool costs prompt tokens on every turn, so nothing turns this
 * on implicitly.
 */
export const withImageGenerationToolInjected: ResponsesInterceptor = async (inv, _ctx, run) => {
  if (!inv.enabledFlags.has('responses-image-generation-inject')) return await run()

  const payload = inv.payload as Record<string, unknown>
  if (payload.tool_choice === 'none') return await run()

  const tools = Array.isArray(payload.tools) ? (payload.tools as ResponsesTool[]) : []
  if (tools.some(isHostedImageGenerationTool)) return await run()

  inv.payload = { ...payload, tools: [...tools, { type: 'image_generation' }] } as typeof inv.payload
  return await run()
}
