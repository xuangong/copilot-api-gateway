// packages/gateway/src/data-plane/chat-flow/chat-completions/serve.ts
import type { DataPlaneAuthCtx } from '../../models/routes.ts'
import { parseChatPayload } from '../../parsers.ts'
import { dispatch, type DispatchObsCtx } from '../shared/dispatch.ts'
import { jsonErrorWrap } from '../shared/error-wrap.ts'

export interface ChatCompletionsServeArgs {
  raw: unknown
  auth: DataPlaneAuthCtx
  obsCtx: DispatchObsCtx
}

export function serveChatCompletions(args: ChatCompletionsServeArgs): Promise<Response> {
  return dispatch(args.raw, {
    parse: (r) => parseChatPayload(r),
    modelOf: (p) => (p as { model?: string }).model ?? '',
    sourceApi: 'chat_completions',
    fallbackMaxOutputTokens: 4096,
    errorWrap: jsonErrorWrap,
    auth: args.auth,
    obsCtx: args.obsCtx,
  })
}
