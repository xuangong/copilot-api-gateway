/** Backend adapter stub: IR → upstream Chat Completions. Week 3. */
import type { BackendAdapter } from '@vnext/translate/contract'

export const chatOut: BackendAdapter = {
  toUpstream() { throw new Error('chatOut.toUpstream: not implemented') },
  decodeSSE() { throw new Error('chatOut.decodeSSE: not implemented') },
  decodeBody() { throw new Error('chatOut.decodeBody: not implemented') },
}
