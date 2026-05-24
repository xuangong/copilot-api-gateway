/**
 * Config import/export v2.
 *
 * v2 of the config-bundle format. Versioned at the top level so old/new
 * dashboards can refuse-or-migrate cleanly. v1 (the legacy ad-hoc JSON
 * dump) is unversioned; we treat any payload without a `version` field as
 * v1 and reject it explicitly from the v2 importer.
 *
 * The bundle contains:
 *   - api_keys[]      — user-facing keys with quotas and web-search wiring
 *   - github_accounts[] — Copilot upstream accounts (token redactable)
 *   - flag_overrides  — global flag overrides (per provider kind, optional)
 *
 * Sensitive fields (api_keys[].key, github_accounts[].token, web-search
 * keys) may be redacted on export by passing `redactSecrets: true`. The
 * importer treats `"__REDACTED__"` sentinels as "leave existing value
 * alone" so a redacted export can still be used to restore non-secret
 * config in a new environment without losing tokens.
 *
 * Not part of this module:
 *   - persistence (this only handles the in-memory shape)
 *   - merge strategy (caller decides upsert-by-id vs replace-all)
 *
 * Format aimed at being human-diffable: keys sorted, 2-space indent.
 */

import type { ApiKey, GitHubAccount } from "~/repo/types"

export const CONFIG_BUNDLE_VERSION = 2 as const

export const REDACTED = "__REDACTED__"

/** Per-provider flag override layer; mirrors FlagOverrides used at runtime. */
export type FlagOverridesV2 = Record<string, boolean>

export interface ConfigBundleV2 {
  version: 2
  exportedAt: string
  apiKeys: ApiKey[]
  githubAccounts: GitHubAccount[]
  flagOverrides?: Partial<Record<"copilot" | "custom" | "azure", FlagOverridesV2>>
}

export interface ExportOptions {
  redactSecrets?: boolean
  /** ISO date string; defaults to `new Date().toISOString()`. */
  now?: string
}

interface BundleInput {
  apiKeys: readonly ApiKey[]
  githubAccounts: readonly GitHubAccount[]
  flagOverrides?: ConfigBundleV2["flagOverrides"]
}

const SECRET_API_KEY_FIELDS: ReadonlyArray<keyof ApiKey> = [
  "key",
  "webSearchLangsearchKey",
  "webSearchTavilyKey",
  "webSearchMsGroundingKey",
]

function redactApiKey(k: ApiKey): ApiKey {
  const out: ApiKey = { ...k }
  for (const f of SECRET_API_KEY_FIELDS) {
    if (out[f]) (out[f] as string) = REDACTED
  }
  return out
}

function redactGithubAccount(a: GitHubAccount): GitHubAccount {
  return { ...a, token: a.token ? REDACTED : a.token }
}

/**
 * Serialize the in-memory config into a v2 bundle. Stable key order; no
 * mutation of input arrays.
 */
export function exportConfigV2(input: BundleInput, options: ExportOptions = {}): ConfigBundleV2 {
  const apiKeys = options.redactSecrets ? input.apiKeys.map(redactApiKey) : [...input.apiKeys]
  const githubAccounts = options.redactSecrets
    ? input.githubAccounts.map(redactGithubAccount)
    : [...input.githubAccounts]
  const bundle: ConfigBundleV2 = {
    version: CONFIG_BUNDLE_VERSION,
    exportedAt: options.now ?? new Date().toISOString(),
    apiKeys,
    githubAccounts,
  }
  if (input.flagOverrides) bundle.flagOverrides = { ...input.flagOverrides }
  return bundle
}

/** Validation outcome for a v2 import. */
export interface ImportResult {
  bundle: ConfigBundleV2
  /** Number of api_keys/github_accounts entries that arrived redacted. */
  redactedCount: number
}

class ImportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ImportError"
  }
}

/**
 * Parse and validate a v2 bundle. Throws `ImportError` if version is not 2
 * or if shape is malformed. Does NOT merge with the live state — caller
 * decides how to apply.
 */
export function parseConfigBundleV2(payload: unknown): ImportResult {
  if (typeof payload !== "object" || payload === null) {
    throw new ImportError("Config bundle must be an object")
  }
  const obj = payload as Record<string, unknown>
  const version = obj.version
  if (version !== CONFIG_BUNDLE_VERSION) {
    throw new ImportError(
      version === undefined
        ? "Missing `version` field — looks like a v1 bundle, which is not accepted"
        : `Unsupported config bundle version: ${String(version)} (expected 2)`,
    )
  }
  const apiKeys = obj.apiKeys
  const githubAccounts = obj.githubAccounts
  if (!Array.isArray(apiKeys)) throw new ImportError("`apiKeys` must be an array")
  if (!Array.isArray(githubAccounts)) throw new ImportError("`githubAccounts` must be an array")

  let redactedCount = 0
  for (const k of apiKeys) {
    if (typeof k !== "object" || k === null) throw new ImportError("apiKeys entry must be object")
    if (typeof (k as ApiKey).id !== "string") throw new ImportError("apiKeys entry missing id")
    if ((k as ApiKey).key === REDACTED) redactedCount++
  }
  for (const a of githubAccounts) {
    if (typeof a !== "object" || a === null) {
      throw new ImportError("githubAccounts entry must be object")
    }
    if ((a as GitHubAccount).token === REDACTED) redactedCount++
  }

  const flagOverrides = obj.flagOverrides
  let normalized: ConfigBundleV2["flagOverrides"]
  if (flagOverrides !== undefined) {
    if (typeof flagOverrides !== "object" || flagOverrides === null || Array.isArray(flagOverrides)) {
      throw new ImportError("`flagOverrides` must be a record keyed by provider kind")
    }
    normalized = flagOverrides as ConfigBundleV2["flagOverrides"]
  }

  const bundle: ConfigBundleV2 = {
    version: CONFIG_BUNDLE_VERSION,
    exportedAt: typeof obj.exportedAt === "string" ? obj.exportedAt : "",
    apiKeys: apiKeys as ApiKey[],
    githubAccounts: githubAccounts as GitHubAccount[],
    ...(normalized ? { flagOverrides: normalized } : {}),
  }
  return { bundle, redactedCount }
}

/**
 * Merge helper: when restoring a redacted bundle into an environment that
 * already has live state, redacted secrets should be preserved from the
 * live record. This walks pairs by id and returns a clone of `incoming`
 * with redacted secret fields swapped back to live values.
 */
export function unredactWithLive(
  incoming: ConfigBundleV2,
  live: { apiKeys: readonly ApiKey[]; githubAccounts: readonly GitHubAccount[] },
): ConfigBundleV2 {
  const liveKeysById = new Map(live.apiKeys.map((k) => [k.id, k]))
  const liveAccountsById = new Map(live.githubAccounts.map((a) => [a.user.id, a]))
  const apiKeys = incoming.apiKeys.map((k) => {
    const here = liveKeysById.get(k.id)
    if (!here) return k
    const merged: ApiKey = { ...k }
    for (const f of SECRET_API_KEY_FIELDS) {
      if (merged[f] === REDACTED && here[f]) (merged[f] as string) = here[f] as string
    }
    return merged
  })
  const githubAccounts = incoming.githubAccounts.map((a) => {
    const here = liveAccountsById.get(a.user.id)
    if (!here) return a
    return a.token === REDACTED ? { ...a, token: here.token } : a
  })
  return { ...incoming, apiKeys, githubAccounts }
}
