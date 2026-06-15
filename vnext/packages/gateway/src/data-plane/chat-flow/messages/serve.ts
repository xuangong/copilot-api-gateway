// packages/gateway/src/data-plane/chat-flow/messages/serve.ts
import type { DataPlaneAuthCtx } from '../../models/routes.ts'
import { parseMessagesPayload } from '../../parsers.ts'
import { dispatch, type DispatchObsCtx } from '../shared/dispatch.ts'
import { jsonErrorWrap } from '../shared/error-wrap.ts'

export interface MessagesServeArgs {
  raw: unknown
  auth: DataPlaneAuthCtx
  obsCtx: DispatchObsCtx
}

export function serveMessages(args: MessagesServeArgs): Promise<Response> {
  return dispatch(args.raw, {
    parse: (r) => parseMessagesPayload(r),
    modelOf: (p) => (p as { model?: string }).model ?? '',
    sourceApi: 'messages',
    errorWrap: jsonErrorWrap,
    auth: args.auth,
    obsCtx: args.obsCtx,
  })
}
