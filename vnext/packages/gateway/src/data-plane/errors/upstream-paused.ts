import { HTTPException } from 'hono/http-exception'
import { geminiErrorBody } from './forward.ts'

/** The 503 body of a pause refusal in the caller's protocol (`code` is `upstream_paused` or `key_paused`). */
export type PausedCode = 'upstream_paused' | 'key_paused' | 'group_quota_exhausted'
export function pausedBody(code: PausedCode, message: string, format?: 'gemini' | 'anthropic'): unknown {
  if (format === 'gemini') return geminiErrorBody(503, message)
  if (format === 'anthropic') return { type: 'error', error: { type: 'api_error', code, message } }
  return { error: { type: 'api_error', code, message } }
}

/** For routes without an attempt/result renderer (embeddings, images, decision, count tokens): every candidate upstream is paused. */
export class UpstreamPausedError extends HTTPException {
  constructor(message: string, retryAfterSeconds: number, format?: 'gemini' | 'anthropic', code: Exclude<PausedCode, 'key_paused'> = 'upstream_paused') {
    super(503, {
      message,
      res: Response.json(
        pausedBody(code, message, format),
        { status: 503, headers: { 'retry-after': String(retryAfterSeconds) } },
      ),
    })
  }
}
