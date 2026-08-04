/**
 * Tiny JSON runtime helpers shared by vendor-normalize interceptors.
 * Mirrors copilot-gateway `packages/gateway/src/shared/json-helpers.ts`.
 */

export type JsonObject = { [k: string]: unknown }

export const asJsonObject = (value: unknown): JsonObject | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : null

export const isJsonObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

export const readJsonNumber = (value: unknown): number | null =>
  typeof value === 'number' ? value : null
