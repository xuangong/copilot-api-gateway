// packages/gateway/src/data-plane/chat-flow/responses/serve.ts
import type { DataPlaneAuthCtx } from '../../models/routes.ts'
import { parseResponsesPayload } from '../../parsers.ts'
import { expandPreviousResponseId } from '../../dispatch/responses-store-bridge.ts'
import { getResponsesStore } from '../../../shared/runtime/responses-store.ts'
import { dispatch, type DispatchObsCtx } from '../shared/dispatch.ts'
import { jsonErrorWrap } from '../shared/error-wrap.ts'

export interface ResponsesServeArgs {
  raw: unknown
  auth: DataPlaneAuthCtx
  obsCtx: DispatchObsCtx
}

export interface ResponsesServeResult {
  response: Response
  mergedInputItems: unknown[]
}

export async function serveResponses(args: ResponsesServeArgs): Promise<ResponsesServeResult> {
  const store = getResponsesStore()
  let mergedInputItems: unknown[] = []
  const response = await dispatch(args.raw, {
    parse: (r) => parseResponsesPayload(r),
    modelOf: (p) => (p as { model?: string }).model ?? '',
    sourceApi: 'responses',
    errorWrap: jsonErrorWrap,
    auth: args.auth,
    obsCtx: args.obsCtx,
    postParse: async (payload) => {
      await expandPreviousResponseId(
        payload as { previous_response_id?: string | null; input?: unknown },
        store,
        args.auth.apiKeyId ?? null,
      )
      const expanded = (payload as { input?: unknown }).input
      mergedInputItems = Array.isArray(expanded) ? (expanded as unknown[]) : []
    },
  })
  return { response, mergedInputItems }
}
