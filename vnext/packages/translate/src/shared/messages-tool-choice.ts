import type { MessagesPayload } from '@vibe-llm/protocols/messages'
import { TranslatorValidationError } from '../errors.ts'

/**
 * A forced tool the request never declared cannot be honoured; dropping it (or weakening it to
 * auto) lets the model answer without the tool the caller demanded (reference #619). Hosted
 * tools count as declared: their own translation decides whether the choice survives.
 */
export function assertForcedToolDeclared(
  choice: { type?: string; name?: string } | undefined,
  declared: MessagesPayload['tools'],
): void {
  if (choice?.type !== 'tool' || !choice.name) return
  if ((declared as Array<{ name?: string }> | undefined)?.some((t) => t.name === choice.name)) return
  throw new TranslatorValidationError(`Anthropic Messages tool_choice names an undeclared tool: ${choice.name}`, 'tool_choice.name')
}
