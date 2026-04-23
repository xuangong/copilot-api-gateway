import { createHmac } from "node:crypto"

function surrogate(secret: string, ownerId: string, kind: string, realId: string): string {
  const h = createHmac("sha256", secret)
  h.update(`${ownerId}:${kind}:${realId}`)
  // base64url, drop padding, take first 16 chars
  return h.digest("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "").slice(0, 16)
}

export function sharedKeyRef(ownerId: string, keyId: string, secret: string): string {
  return surrogate(secret, ownerId, "key", keyId)
}
export function sharedAccountRef(ownerId: string, accountId: string, secret: string): string {
  return surrogate(secret, ownerId, "account", accountId)
}
export function sharedRelayRef(ownerId: string, clientId: string, secret: string): string {
  return surrogate(secret, ownerId, "relay", clientId)
}

type RedactInput =
  | { kind: "tokenUsage"; payload: any[]; ownerId: string; secret: string }
  | { kind: "latency"; payload: any[]; ownerId: string; secret: string }
  | { kind: "upstreamAccounts"; payload: any[]; ownerId: string; secret: string }
  | { kind: "relays"; payload: any[]; ownerId: string; secret: string }

export function redactForSharedView(input: RedactInput): any[] {
  const { ownerId, secret } = input
  switch (input.kind) {
    case "tokenUsage":
    case "latency":
      return input.payload.map((r: any) => ({
        ...r,
        keyId: sharedKeyRef(ownerId, r.keyId, secret),
      }))
    case "upstreamAccounts":
      return input.payload.map((a: any) => ({
        id: sharedAccountRef(ownerId, String(a.id), secret),
        login: a.login,
        avatar_url: a.avatar_url,
        active: a.active,
        token_valid: a.token_valid,
        quota: a.quota,
      }))
    case "relays":
      return input.payload.map((c: any, idx: number) => ({
        id: sharedRelayRef(ownerId, c.clientId, secret),
        clientLabel: c.keyName || `Relay #${idx + 1}`,
        status: c.isOnline ? "connected" : "disconnected",
        isOnline: c.isOnline,
        isActive: c.isActive,
        lastSeenAt: c.lastSeenAt,
      }))
  }
}

/** Read SERVER_SECRET from env or fall back to a deterministic dev value. */
export function getServerSecret(env: Record<string, string | undefined>): string {
  return env.SERVER_SECRET || env.ADMIN_KEY || "dev-server-secret-change-me"
}
