// packages/gateway/src/data-plane/chat-flow/responses/snapshot-sidecar.ts
import type { Context } from 'hono'
import { parseResponsesSSEStream } from '@vnext/provider-copilot'
import { savePostTurnSnapshot } from '../../dispatch/responses-store-bridge.ts'
import { getResponsesStore } from '../../../shared/runtime/responses-store.ts'

/**
 * Sidecar snapshot writers for /v1/responses.
 *
 * Stream branch tees the SSE body, parses upstream events to capture the
 * response id + output items, and persists a post-turn snapshot. Non-stream
 * branch clones the JSON response and reads `id` + `output` from the body.
 *
 * Both branches bind the save promise to the CFW ExecutionContext via
 * `waitUntil` when present so the runtime keeps the worker alive past
 * response settlement; on local Bun there is no executionCtx, so we fall
 * back to fire-and-forget with a swallowed catch (each save IIFE already
 * logs failures).
 */

interface SidecarArgs {
  c: Context
  response: Response
  fallbackModel: string
  apiKeyId: string | null
  requestId: string | null
  mergedInputItems: unknown[]
}

export function attachStreamSidecar(args: SidecarArgs): Response {
  if (!args.response.body) return args.response
  const store = getResponsesStore()
  const [forClient, forSidecar] = args.response.body.tee()
  const { fallbackModel, apiKeyId, requestId, mergedInputItems } = args

  const sidecarPromise = (async () => {
    let responseId: string | null = null
    let model = fallbackModel
    const outputItems: unknown[] = []
    try {
      for await (const evt of parseResponsesSSEStream(forSidecar)) {
        const e = evt as { type?: string; response?: { id?: string; model?: string }; item?: unknown }
        if (e.type === 'response.created' && e.response?.id) {
          responseId = e.response.id
          if (e.response.model) model = e.response.model
        } else if (e.type === 'response.output_item.done' && e.item) {
          outputItems.push(e.item)
        } else if (e.type === 'response.completed') {
          if (e.response?.id && !responseId) responseId = e.response.id
          if (e.response?.model) model = e.response.model
        }
      }
      if (responseId) {
        await savePostTurnSnapshot(store, {
          responseId,
          apiKeyId,
          model,
          inputItems: mergedInputItems,
          outputItems,
        })
      }
    } catch (err) {
      console.warn(JSON.stringify({
        evt: '[responses-snapshot] stream save failed',
        rid: requestId,
        responseId,
        apiKeyId,
        model,
        message: err instanceof Error ? err.message : String(err),
      }))
    }
  })()

  bindToExecutionCtx(args.c, sidecarPromise)
  return new Response(forClient, { status: args.response.status, headers: args.response.headers })
}

export function attachNonStreamSidecar(args: SidecarArgs): Response {
  const store = getResponsesStore()
  const cloned = args.response.clone()
  const { fallbackModel, apiKeyId, requestId, mergedInputItems } = args

  const savePromise = (async () => {
    try {
      const json = await cloned.json() as {
        id?: string
        model?: string
        output?: unknown[]
      }
      if (typeof json.id === 'string' && Array.isArray(json.output)) {
        await savePostTurnSnapshot(store, {
          responseId: json.id,
          apiKeyId,
          model: typeof json.model === 'string' ? json.model : fallbackModel,
          inputItems: mergedInputItems,
          outputItems: json.output,
        })
      }
    } catch (err) {
      console.warn(JSON.stringify({
        evt: '[responses-snapshot] non-stream save failed',
        rid: requestId,
        apiKeyId,
        model: fallbackModel,
        message: err instanceof Error ? err.message : String(err),
      }))
    }
  })()

  bindToExecutionCtx(args.c, savePromise)
  return args.response
}

function bindToExecutionCtx(c: Context, promise: Promise<void>): void {
  try {
    c.executionCtx?.waitUntil(promise)
  } catch {
    promise.catch(() => { /* swallowed; save IIFE already logs */ })
  }
}
