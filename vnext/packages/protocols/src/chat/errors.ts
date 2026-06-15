// packages/protocols/src/chat/errors.ts
type JsonObject = Record<string, unknown>

const isObjectLike = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null

export const chatCompletionsErrorPayloadMessage = (value: unknown): string | null => {
  if (!isObjectLike(value) || !isObjectLike(value.error)) return null
  const type = typeof value.error.type === 'string' ? value.error.type : null
  const message =
    typeof value.error.message === 'string' ? value.error.message : JSON.stringify(value.error)
  return `${type ? `${type}: ` : ''}${message}`
}
