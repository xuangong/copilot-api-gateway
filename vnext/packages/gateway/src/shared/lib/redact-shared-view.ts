/**
 * Shared-view redaction helpers — vNext port of src/lib/redact-shared-view.ts.
 *
 * Replaces real internal IDs (keyId/accountId/clientId) with HMAC-derived
 * surrogates so that observability shares don't leak cross-owner references.
 * Surrogates are deterministic per (ownerId, kind, realId) under a server
 * secret, allowing the shared dashboard to group by surrogate without
 * disclosing the underlying id.
 *
 * `createHmac` runs on Bun and CFW (with nodejs_compat flag, enabled in
 * vnext/apps/gateway/wrangler.jsonc).
 */
import { createHmac } from 'node:crypto'

function surrogate(secret: string, ownerId: string, kind: string, realId: string): string {
  const h = createHmac('sha256', secret)
  h.update(`${ownerId}:${kind}:${realId}`)
  return h.digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, 16)
}

export function sharedKeyRef(ownerId: string, keyId: string, secret: string): string {
  return surrogate(secret, ownerId, 'key', keyId)
}
export function sharedAccountRef(ownerId: string, accountId: string, secret: string): string {
  return surrogate(secret, ownerId, 'account', accountId)
}
export function sharedRelayRef(ownerId: string, clientId: string, secret: string): string {
  return surrogate(secret, ownerId, 'relay', clientId)
}

type RedactInput =
  | { kind: 'tokenUsage'; payload: Array<Record<string, unknown> & { keyId: string }>; ownerId: string; secret: string }
  | { kind: 'latency'; payload: Array<Record<string, unknown> & { keyId: string }>; ownerId: string; secret: string }
  | { kind: 'upstreamAccounts'; payload: Array<Record<string, unknown> & { id: string | number }>; ownerId: string; secret: string }
  | { kind: 'relays'; payload: Array<Record<string, unknown> & { clientId: string; keyName?: string; isOnline?: boolean; isActive?: boolean; lastSeenAt?: unknown }>; ownerId: string; secret: string }

export function redactForSharedView(input: RedactInput): Array<Record<string, unknown>> {
  const { ownerId, secret } = input
  switch (input.kind) {
    case 'tokenUsage':
    case 'latency':
      return input.payload.map((r) => ({
        ...r,
        keyId: sharedKeyRef(ownerId, r.keyId, secret),
      }))
    case 'upstreamAccounts':
      return input.payload.map((a) => ({
        id: sharedAccountRef(ownerId, String(a.id), secret),
        login: a.login,
        avatar_url: a.avatar_url,
        active: a.active,
        token_valid: a.token_valid,
        quota: a.quota,
      }))
    case 'relays':
      return input.payload.map((c, idx) => ({
        id: sharedRelayRef(ownerId, c.clientId, secret),
        clientLabel: c.keyName || `Relay #${idx + 1}`,
        status: c.isOnline ? 'connected' : 'disconnected',
        isOnline: c.isOnline,
        isActive: c.isActive,
        lastSeenAt: c.lastSeenAt,
      }))
  }
}

export function getServerSecret(env: Record<string, string | undefined>): string {
  if (!env.SERVER_SECRET) {
    throw new Error('SERVER_SECRET must be set')
  }
  return env.SERVER_SECRET
}
