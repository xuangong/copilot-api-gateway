// packages/gateway/src/data-plane/chat-flow/gemini/serve.ts
import type { DataPlaneAuthCtx } from '../../models/routes.ts'
import { parseGeminiPayload } from '../../parsers.ts'
import { dispatch, type DispatchObsCtx } from '../shared/dispatch.ts'
import { jsonErrorWrap } from '../shared/error-wrap.ts'

export interface GeminiServeArgs {
  raw: unknown
  model: string
  forceStream: boolean
  auth: DataPlaneAuthCtx
  obsCtx: DispatchObsCtx
}

export function serveGemini(args: GeminiServeArgs): Promise<Response> {
  return dispatch(args.raw, {
    parse: (r) => parseGeminiPayload(r),
    modelOf: () => args.model,
    forceStream: args.forceStream,
    fallbackMaxOutputTokens: 4096,
    sourceApi: 'gemini',
    errorWrap: jsonErrorWrap,
    auth: args.auth,
    obsCtx: args.obsCtx,
  })
}
