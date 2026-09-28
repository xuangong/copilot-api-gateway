import type { MessagesInterceptor } from './types'

import { PROMPT_TOO_LONG_MESSAGE, messageIsContextExceeded, isContextExceededError } from "@vibe-llm/protocols/messages"

const PROMPT_TOO_LONG_BODY = new TextEncoder().encode(
  JSON.stringify({
    type: 'error',
    error: { type: 'invalid_request_error', message: PROMPT_TOO_LONG_MESSAGE },
  }),
)

interface MaybeErrorBody { error?: unknown }

const isContextExceededErrorObject = (parsed: unknown): boolean => {
  if (parsed === null || typeof parsed !== 'object') return false
  return isContextExceededError((parsed as MaybeErrorBody).error)
}

const isContextExceededErrorText = (text: string): boolean => {
  try {
    return isContextExceededErrorObject(JSON.parse(text))
  } catch {
    return messageIsContextExceeded(text)
  }
}

/**
 * Rewrites any context-exceeded upstream error into the canonical Anthropic
 * `prompt is too long` envelope so Claude Code's auto-compaction gate fires.
 *
 * References:
 * - https://docs.claude.com/en/docs/claude-code/common-workflows#prompt-too-long
 * - copilot-gateway `translate/src/shared/messages-via/context-window-error.ts`
 */
export const withContextWindowErrorRewritten: MessagesInterceptor = async (_inv, _ctx, run) => {
  const result = await run()
  if (result.type !== 'upstream-error') return result

  const body = new TextDecoder().decode(result.body)
  if (!isContextExceededErrorText(body)) return result

  return {
    ...result,
    type: 'upstream-error',
    status: 400,
    headers: new Headers({ 'content-type': 'application/json' }),
    body: PROMPT_TOO_LONG_BODY,
  }
}
