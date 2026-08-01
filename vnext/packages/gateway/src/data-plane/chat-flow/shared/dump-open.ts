// Per-request dump entry seam for chat-flow HTTP handlers.
//
// Reads the inbound body once (via `readRequestBody`) so the handler's payload
// parser AND the dump accumulator share the exact same bytes, then opens the
// accumulator only when the caller's api key has retention configured. When
// no api key is authenticated or the key opts out, both `bytes` and `dump`
// are still returned so the handler can continue unchanged — the dump slot
// is simply `null`.
//
// The api-key lookup is by id (not by hash); `sessionAuthMiddleware` has
// already resolved and validated the credential and stashed the id on
// `auth.apiKeyId`. Repo miss → treated as no-retention (best-effort).
import type { Context } from 'hono'
import { getRepo } from '../../../shared/repo/index.ts'
import { openDumpAccumulator, type DumpAccumulator } from '../../../shared/dump/accumulator.ts'
import { readRequestBody, type RequestBody } from '../../../shared/dump/request-body.ts'
import type { DataPlaneAuthCtx } from '../../models/routes.ts'

export interface DumpOpenResult {
  readonly requestBody: RequestBody
  readonly dump: DumpAccumulator | null
}

export const openRequestDump = async (
  c: Context,
  auth: DataPlaneAuthCtx,
  method: string,
): Promise<DumpOpenResult> => {
  const requestBody = await readRequestBody(c)
  const apiKeyId = auth.apiKeyId
  if (!apiKeyId) return { requestBody, dump: null }
  try {
    const apiKey = await getRepo().apiKeys.getById(apiKeyId)
    if (!apiKey) return { requestBody, dump: null }
    return { requestBody, dump: openDumpAccumulator(c, method, apiKey, requestBody) }
  } catch {
    return { requestBody, dump: null }
  }
}

// Decode the buffered request body as JSON. Handlers previously called
// `await c.req.json()`; with the dump seam owning the read they instead
// consume the buffered bytes so the wire body flows through the pipeline
// exactly once.
export const parseJsonBody = (bytes: Uint8Array): unknown => {
  if (bytes.byteLength === 0) throw new SyntaxError('empty body')
  return JSON.parse(new TextDecoder().decode(bytes))
}
