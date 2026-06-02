/**
 * Forward primitive: Messages `output_config.format` (Anthropic-flavoured
 * `{ type: 'json_schema', schema }`) → OpenAI `json_schema` core
 * (`{ name, strict: true, schema }`).
 *
 * Anthropic structured outputs only carry `type` and `schema`; OpenAI requires
 * a `name`, so we mint the constant `'messages_response'` (mirroring the
 * Gemini side's `'gemini_response'`) and set `strict: true` — Anthropic
 * already promises schema-strict compliance, so this is the closest OpenAI
 * equivalent. Schemas that violate OpenAI strict-mode constraints (e.g.
 * missing `additionalProperties: false`) pass through unmodified and are
 * rejected upstream with a clear error rather than silently coerced.
 *
 * The reverse direction (OpenAI response-format → Messages) is the source
 * protocol's own wire shape — flat for Responses (`text.format`), nested for
 * Chat (`response_format.json_schema`) — so each `*-via-messages` builder
 * extracts it inline rather than sharing a cross-shape parser.
 *
 * Spec: https://platform.claude.com/docs/en/build-with-claude/structured-outputs
 */

import type { AnthropicMessagesPayload } from "~/transforms/types"

export const MESSAGES_OPENAI_JSON_SCHEMA_NAME = "messages_response"

export interface OpenAiJsonSchemaCore {
  name: string
  strict: true
  schema: Record<string, unknown>
}

type MessagesOutputFormat = NonNullable<AnthropicMessagesPayload["output_config"]>["format"]

export function openAiJsonSchemaCoreFromMessagesFormat(
  format: MessagesOutputFormat | undefined,
): OpenAiJsonSchemaCore | undefined {
  if (format?.type !== "json_schema") return undefined
  return { name: MESSAGES_OPENAI_JSON_SCHEMA_NAME, strict: true, schema: format.schema }
}
