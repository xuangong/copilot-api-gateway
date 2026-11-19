/**
 * Building blocks for `LlmProviderPlugin.publicConfig`: the dashboard-safe
 * projection of an upstream's stored config.
 *
 * The projection is an allowlist. Copy only named scalar fields, mask every
 * credential, and never spread the source — a field added to a provider's
 * config later must stay private until it is listed here explicitly.
 */

export type PublicConfig = Record<string, unknown>

/** The value as a plain object, or `{}`. */
export function configRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

/** Copy the listed keys whose values are null, strings, booleans or finite numbers. */
export function pickScalars(value: unknown, keys: readonly string[]): PublicConfig {
  const source = configRecord(value)
  const out: PublicConfig = {}
  for (const key of keys) {
    const entry = source[key]
    if (entry === null || typeof entry === "string" || typeof entry === "boolean" || (typeof entry === "number" && Number.isFinite(entry))) out[key] = entry
  }
  return out
}

/** The string entries of an array, or undefined when it is not an array. */
export function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : undefined
}

/** Report whether a credential is set without revealing it: "***" when set, "" when empty, null when null. */
export function maskSecret(out: PublicConfig, source: Record<string, unknown>, key: string): void {
  if (Object.hasOwn(source, key)) out[key] = source[key] ? "***" : source[key] === null ? null : ""
}

/**
 * Fields shared by API-key HTTP upstreams (custom, azure): the opaque
 * compatibility declaration (when it parses), the masked key, the endpoint
 * list and default header names with masked values.
 */
export function withHttpCredentialFields(out: PublicConfig, source: Record<string, unknown>, parseOpaqueCompatibility: (value: unknown) => unknown): PublicConfig {
  if (source.opaqueCompatibility !== undefined) {
    try {
      out.opaqueCompatibility = parseOpaqueCompatibility(source.opaqueCompatibility)
    } catch { /* Invalid stored declarations grant no public fields. */ }
  }
  maskSecret(out, source, "apiKey")
  if (source.endpoints) out.endpoints = stringList(source.endpoints)
  if (source.defaultHeaders) out.defaultHeaders = Object.fromEntries(Object.keys(configRecord(source.defaultHeaders)).map(key => [key, "***"]))
  return out
}

/**
 * Backup rules for an upstream whose config may carry an opaque-compatibility
 * declaration (custom, azure): the declaration is exported verbatim, and an
 * import with a malformed one is refused.
 */
export function opaqueCompatibilityBackupRules(parse: (value: unknown) => unknown) {
  return {
    verbatimConfig(config: Record<string, unknown>): Record<string, unknown> {
      try {
        const declaration = parse(config.opaqueCompatibility)
        return declaration === undefined ? {} : { opaqueCompatibility: declaration }
      } catch { return {} }
    },
    validateImport(config: Record<string, unknown>): void { parse(config.opaqueCompatibility) },
  }
}
