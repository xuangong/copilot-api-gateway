/** Backend adapter stub: IR → upstream Anthropic Messages. */
import type { BackendAdapter } from '@vnext/translate/contract'

export const messagesOut: BackendAdapter = {
  toUpstream() { throw new Error('messagesOut.toUpstream: not implemented') },
  decodeSSE() { throw new Error('messagesOut.decodeSSE: not implemented') },
  decodeBody() { throw new Error('messagesOut.decodeBody: not implemented') },
}
