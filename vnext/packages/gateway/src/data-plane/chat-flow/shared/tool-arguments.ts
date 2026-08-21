/**
 * Shared parser for a function tool call's `arguments` string.
 *
 * Every server-tool shim (Responses server tools, the Chat Completions
 * web-search shim) faces the same problem: models emit `arguments` as a
 * string that is *usually* JSON, and a truncated or trailing-comma'd payload
 * should degrade into a model-visible schema error rather than a 500.
 * `jsonrepair` handles the common malformations; anything that still doesn't
 * parse to a JSON object reads as `null` and the caller turns that into an
 * error the model can correct on the next turn.
 */
import { jsonrepair } from 'jsonrepair'

export const parseServerToolArguments = (argumentsJson: string): Record<string, unknown> | null => {
  if (argumentsJson === '') return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonrepair(argumentsJson))
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  return parsed as Record<string, unknown>
}
