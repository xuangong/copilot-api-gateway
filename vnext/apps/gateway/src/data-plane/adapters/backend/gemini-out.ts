/** Backend adapter stub: IR → upstream Gemini. */
import type { BackendAdapter } from '@vnext/translate/contract'

export const geminiOut: BackendAdapter = {
  toUpstream() { throw new Error('geminiOut.toUpstream: not implemented') },
  decodeSSE() { throw new Error('geminiOut.decodeSSE: not implemented') },
  decodeBody() { throw new Error('geminiOut.decodeBody: not implemented') },
}
