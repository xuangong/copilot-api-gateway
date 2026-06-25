/**
 * Config import/export bundle (Week 5b port of src/config/import-export.ts).
 *
 * v2 bundle: apiKeys + githubAccounts + upstreams + optional flagOverrides.
 * v1 payloads are lifted to v2 with an empty upstreams array; exports
 * always write v2. Secrets may be redacted on export and restored from
 * live state on import via unredactWithLive().
 */
import type { UpstreamKind } from '@vibe-llm/protocols/common'
import type { ApiKey, GitHubAccount, UpstreamRecord } from '../repo/types.ts'

export const CONFIG_BUNDLE_VERSION = 2 as const
export const REDACTED = '__REDACTED__'

export type FlagOverrides = Record<string, boolean>

export interface ConfigBundle {
  version: 2
  exportedAt: string
  apiKeys: ApiKey[]
  githubAccounts: GitHubAccount[]
  upstreams: UpstreamRecord[]
  flagOverrides?: Partial<Record<UpstreamKind, FlagOverrides>>
}

export interface ExportOptions {
  redactSecrets?: boolean
  now?: string
}

interface BundleInput {
  apiKeys: readonly ApiKey[]
  githubAccounts: readonly GitHubAccount[]
  upstreams?: readonly UpstreamRecord[]
  flagOverrides?: ConfigBundle['flagOverrides']
}

const SECRET_API_KEY_FIELDS: ReadonlyArray<keyof ApiKey> = [
  'key',
  'webSearchLangsearchKey',
  'webSearchTavilyKey',
  'webSearchMsGroundingKey',
]

const SECRET_CONFIG_KEY_RE = /token|apikey|api_key|authorization|password|secret/i

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

function redactConfigBlob(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactConfigBlob)
  if (!value || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_CONFIG_KEY_RE.test(k)) out[k] = v ? REDACTED : v
    else out[k] = redactConfigBlob(v)
  }
  return out
}

function redactUpstream(u: UpstreamRecord): UpstreamRecord {
  return { ...u, config: redactConfigBlob(u.config) as Record<string, unknown> }
}

function unredactConfigBlob(incoming: unknown, live: unknown): unknown {
  if (Array.isArray(incoming)) {
    const liveArr = Array.isArray(live) ? live : []
    return incoming.map((item, i) => unredactConfigBlob(item, liveArr[i]))
  }
  if (!incoming || typeof incoming !== 'object') return incoming
  const liveObj = live && typeof live === 'object' && !Array.isArray(live)
    ? (live as Record<string, unknown>)
    : {}
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(incoming as Record<string, unknown>)) {
    if (v === REDACTED && typeof liveObj[k] === 'string' && liveObj[k]) {
      out[k] = liveObj[k]
    } else {
      out[k] = unredactConfigBlob(v, liveObj[k])
    }
  }
  return out
}

export function exportConfig(input: BundleInput, options: ExportOptions = {}): ConfigBundle {
  const apiKeys = options.redactSecrets ? input.apiKeys.map(redactApiKey) : [...input.apiKeys]
  const githubAccounts = options.redactSecrets
    ? input.githubAccounts.map(redactGithubAccount)
    : [...input.githubAccounts]
  const upstreamsIn = input.upstreams ?? []
  const upstreams = options.redactSecrets ? upstreamsIn.map(redactUpstream) : [...upstreamsIn]
  const bundle: ConfigBundle = {
    version: CONFIG_BUNDLE_VERSION,
    exportedAt: options.now ?? new Date().toISOString(),
    apiKeys,
    githubAccounts,
    upstreams,
  }
  if (input.flagOverrides) bundle.flagOverrides = { ...input.flagOverrides }
  return bundle
}

export interface ImportResult {
  bundle: ConfigBundle
  redactedCount: number
  sourceVersion: 1 | 2
}

export class ImportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ImportError'
  }
}

function countRedactedInBlob(value: unknown): number {
  if (value === REDACTED) return 1
  if (Array.isArray(value)) return value.reduce<number>((n, v) => n + countRedactedInBlob(v), 0)
  if (value && typeof value === 'object') {
    let n = 0
    for (const v of Object.values(value as Record<string, unknown>)) n += countRedactedInBlob(v)
    return n
  }
  return 0
}

export function parseConfigBundle(payload: unknown): ImportResult {
  if (typeof payload !== 'object' || payload === null) {
    throw new ImportError('Config bundle must be an object')
  }
  const obj = payload as Record<string, unknown>
  const version = obj.version
  if (version !== 1 && version !== 2) {
    throw new ImportError(
      version === undefined
        ? 'Missing `version` field — payload is not a config bundle'
        : `Unsupported config bundle version: ${String(version)} (expected 1 or ${CONFIG_BUNDLE_VERSION})`,
    )
  }
  const sourceVersion = version as 1 | 2
  const apiKeys = obj.apiKeys
  const githubAccounts = obj.githubAccounts
  if (!Array.isArray(apiKeys)) throw new ImportError('`apiKeys` must be an array')
  if (!Array.isArray(githubAccounts)) throw new ImportError('`githubAccounts` must be an array')

  let redactedCount = 0
  for (const k of apiKeys) {
    if (typeof k !== 'object' || k === null) throw new ImportError('apiKeys entry must be object')
    if (typeof (k as ApiKey).id !== 'string') throw new ImportError('apiKeys entry missing id')
    for (const f of SECRET_API_KEY_FIELDS) {
      if ((k as ApiKey)[f] === REDACTED) redactedCount++
    }
  }
  for (const a of githubAccounts) {
    if (typeof a !== 'object' || a === null) {
      throw new ImportError('githubAccounts entry must be object')
    }
    if ((a as GitHubAccount).token === REDACTED) redactedCount++
  }

  let upstreams: UpstreamRecord[] = []
  if (sourceVersion === 2) {
    const raw = obj.upstreams
    if (raw !== undefined) {
      if (!Array.isArray(raw)) throw new ImportError('`upstreams` must be an array')
      for (const u of raw) {
        if (typeof u !== 'object' || u === null) throw new ImportError('upstreams entry must be object')
        const rec = u as UpstreamRecord
        if (typeof rec.id !== 'string' || !rec.id) throw new ImportError('upstreams entry missing id')
        if (rec.provider !== 'copilot' && rec.provider !== 'custom' && rec.provider !== 'azure') {
          throw new ImportError(`upstreams entry has unsupported provider: ${String(rec.provider)}`)
        }
        if (typeof rec.name !== 'string') throw new ImportError('upstreams entry missing name')
        if (!rec.config || typeof rec.config !== 'object' || Array.isArray(rec.config)) {
          throw new ImportError('upstreams entry config must be object')
        }
        redactedCount += countRedactedInBlob(rec.config)
      }
      upstreams = raw as UpstreamRecord[]
    }
  }

  const flagOverrides = obj.flagOverrides
  let normalized: ConfigBundle['flagOverrides']
  if (flagOverrides !== undefined) {
    if (typeof flagOverrides !== 'object' || flagOverrides === null || Array.isArray(flagOverrides)) {
      throw new ImportError('`flagOverrides` must be a record keyed by provider kind')
    }
    normalized = flagOverrides as ConfigBundle['flagOverrides']
  }

  const bundle: ConfigBundle = {
    version: CONFIG_BUNDLE_VERSION,
    exportedAt: typeof obj.exportedAt === 'string' ? obj.exportedAt : '',
    apiKeys: apiKeys as ApiKey[],
    githubAccounts: githubAccounts as GitHubAccount[],
    upstreams,
    ...(normalized ? { flagOverrides: normalized } : {}),
  }
  return { bundle, redactedCount, sourceVersion }
}

export function unredactWithLive(
  incoming: ConfigBundle,
  live: {
    apiKeys: readonly ApiKey[]
    githubAccounts: readonly GitHubAccount[]
    upstreams?: readonly UpstreamRecord[]
  },
): ConfigBundle {
  const liveKeysById = new Map(live.apiKeys.map((k) => [k.id, k]))
  const liveAccountsById = new Map(live.githubAccounts.map((a) => [a.user.id, a]))
  const liveUpstreamsById = new Map((live.upstreams ?? []).map((u) => [u.id, u]))
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
  const upstreams = incoming.upstreams.map((u) => {
    const here = liveUpstreamsById.get(u.id)
    if (!here) return u
    return { ...u, config: unredactConfigBlob(u.config, here.config) as Record<string, unknown> }
  })
  return { ...incoming, apiKeys, githubAccounts, upstreams }
}
