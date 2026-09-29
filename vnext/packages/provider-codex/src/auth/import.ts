import type { CodexUpstreamConfig } from "../config"
import type { CodexUpstreamState } from "../state"
import type { Fetcher } from "../fetcher"
import { normalizeCodexCredential, type CodexCredentialInput, type NormalizedCodexCredential } from "./credential"
import { parseCodexIdTokenClaims } from "./jwt"
import { exchangeCodexAuthorizationCode } from "./oauth"

export interface CodexImportResult {
  config: CodexUpstreamConfig
  state: CodexUpstreamState
}

export interface CodexJsonPreviewCandidate {
  sourceIndex: number
  name: string | null
  email: string | null
  chatgptAccountId: string | null
  chatgptUserId: string | null
  planType: string | null
  renewable: boolean
  expiresAt: number | null
  importable: boolean
  issues: string[]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const requireRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`)
  return value
}

const buildImport = (credential: NormalizedCodexCredential, now = new Date().toISOString()): CodexImportResult => ({
  config: { accounts: [credential.identity] },
  state: { accounts: [{
    chatgptAccountId: credential.identity.chatgptAccountId,
    refresh_token: credential.refreshToken,
    credentialRevision: crypto.randomUUID(),
    state: "active",
    state_updated_at: now,
    openaiDeviceId: crypto.randomUUID(),
    accessToken: credential.accessToken === null ? null : {
      token: credential.accessToken,
      expiresAt: credential.expiresAt,
      refreshedAt: now,
    },
    quotaSnapshot: null,
  }] },
})

export const parseSourceExpiry = (value: unknown, label = "expires_at"): number | null => {
  if (value === undefined || value === null || value === "" || value === 0 || value === "0") return null
  let millis: number
  if (typeof value === "number") {
    millis = value * 1000
  } else if (typeof value === "string" && /^\d+$/.test(value)) {
    millis = Number(value) * 1000
  } else if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    millis = Date.parse(value)
  } else {
    throw new TypeError(`${label} must be epoch seconds or ISO timestamp`)
  }
  if (!Number.isFinite(millis) || millis <= 0) throw new TypeError(`${label} must be a finite positive time`)
  return millis
}

interface Source {
  sourceIndex: number
  name: string | null
  supported: boolean
  normalize: () => NormalizedCodexCredential
}

const credentialInput = (record: Record<string, unknown>, root: Record<string, unknown>): CodexCredentialInput => ({
  accessToken: record.access_token as string | null | undefined,
  refreshToken: record.refresh_token as string | null | undefined,
  idToken: record.id_token as string | null | undefined,
  chatgptAccountId: (record.chatgpt_account_id ?? record.account_id ?? root.chatgpt_account_id ?? root.account_id) as string | null | undefined,
  email: (record.email ?? root.email) as string | null | undefined,
  chatgptUserId: (record.chatgpt_user_id ?? root.chatgpt_user_id) as string | null | undefined,
  planType: (record.plan_type ?? root.plan_type) as string | null | undefined,
  expiresAt: parseSourceExpiry(record.expires_at ?? root.expires_at),
})

const supportedCodexTags = (...values: unknown[]): boolean => values.every(value => {
  if (!isRecord(value)) return true
  const matches = (key: string, expected: string): boolean => {
    const tag = value[key]
    return tag === undefined || tag === null || (typeof tag === "string" && tag.trim().toLowerCase() === expected)
  }
  return matches("platform", "openai") && matches("type", "oauth")
})

const makeSource = (value: unknown, index: number, label: string, ancestors: readonly unknown[] = []): Source => {
  const record = isRecord(value) ? value : null
  return {
    sourceIndex: index,
    name: typeof record?.name === "string" && record.name.trim() ? record.name : null,
    supported: supportedCodexTags(...ancestors, value, record?.credentials),
    normalize: () => {
      const account = requireRecord(value, label)
      return normalizeCodexCredential(credentialInput(requireRecord(account.credentials, `${label}.credentials`), account))
    },
  }
}

const accountSources = (value: unknown, label: string, ancestors: readonly unknown[]): Source[] => {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`)
  if (value.length > 100) throw new TypeError("Codex credential JSON has too many accounts")
  return value.map((entry, index) => makeSource(entry, index, `${label}[${index}]`, ancestors))
}

const parseSources = (rawJson: string): Source[] => {
  if (new TextEncoder().encode(rawJson).byteLength > 1024 * 1024) throw new TypeError("Codex credential JSON is too large")
  let parsed: unknown
  try { parsed = JSON.parse(rawJson) } catch { throw new TypeError("Codex credential JSON is invalid") }
  const root = requireRecord(parsed, "Codex credential JSON")
  const data = root.data
  const kinds = [
    Object.hasOwn(root, "tokens") ? "tokens" : null,
    Object.hasOwn(root, "credentials") ? "credentials" : null,
    Object.hasOwn(root, "accounts") ? "accounts" : null,
    isRecord(data) && Object.hasOwn(data, "accounts") ? "nested" : null,
    Object.hasOwn(root, "access_token") || Object.hasOwn(root, "refresh_token") ? "flat" : null,
  ].filter((kind): kind is string => kind !== null)
  if (kinds.length === 0) throw new TypeError("Codex credential JSON has no supported envelope")
  if (kinds.length > 1) throw new TypeError("Codex credential JSON is ambiguous")
  switch (kinds[0]) {
    case "tokens": return [{ sourceIndex: 0, name: null, supported: supportedCodexTags(root, root.tokens),
      normalize: () => normalizeCodexCredential(credentialInput(requireRecord(root.tokens, "tokens"), root)) }]
    case "credentials": return [makeSource(root, 0, "root")]
    case "accounts": return accountSources(root.accounts, "accounts", [root])
    case "nested": return accountSources(isRecord(data) ? data.accounts : null, "data.accounts", [root, data])
    default: return [{ sourceIndex: 0, name: null, supported: supportedCodexTags(root),
      normalize: () => normalizeCodexCredential(credentialInput(root, root)) }]
  }
}

export const previewCodexJson = async (rawJson: string): Promise<CodexJsonPreviewCandidate[]> =>
  parseSources(rawJson).flatMap<CodexJsonPreviewCandidate>(source => {
    if (!source.supported) return []
    try {
      const credential = source.normalize()
      return [{
        sourceIndex: source.sourceIndex, name: source.name,
        ...credential.identity, renewable: credential.refreshToken !== null,
        expiresAt: credential.expiresAt, importable: true, issues: [],
      }]
    } catch (error) {
      return [{
        sourceIndex: source.sourceIndex, name: source.name,
        email: null, chatgptAccountId: null, chatgptUserId: null, planType: null,
        renewable: false, expiresAt: null, importable: false,
        issues: [error instanceof Error ? error.message : "Codex credential is invalid"],
      }]
    }
  })

export const importCodexFromJson = async (rawJson: string, sourceIndex: number): Promise<CodexImportResult> => {
  if (!Number.isSafeInteger(sourceIndex) || sourceIndex < 0) throw new TypeError("Codex source index is invalid")
  const source = parseSources(rawJson).find(candidate => candidate.sourceIndex === sourceIndex)
  if (!source || !source.supported) throw new TypeError("Codex source index is unavailable")
  return buildImport(source.normalize())
}

export const importCodexFromAuthJson = async (rawJson: string): Promise<CodexImportResult> =>
  importCodexFromJson(rawJson, 0)

export const importCodexFromCallback = async (opts: {
  code: string
  codeVerifier: string
  fetcher: Fetcher
}): Promise<CodexImportResult> => {
  const tokens = await exchangeCodexAuthorizationCode(opts)
  const identity = parseCodexIdTokenClaims(tokens.id_token)
  const credential = normalizeCodexCredential({
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    idToken: tokens.id_token,
    chatgptAccountId: identity.chatgptAccountId,
    expiresAt: Date.now() + tokens.expires_in * 1000,
  })
  return buildImport(credential)
}
