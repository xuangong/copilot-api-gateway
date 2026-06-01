import { api } from "./client"

// Relay/client presence record as returned by GET /api/relays.
// Shape mirrors src/routes/dashboard.ts "relays" handler (enriched presence row).
export interface RelayClient {
  clientId: string
  clientName?: string | null
  clientLabel?: string | null
  keyId?: string | null
  keyName?: string | null
  ownerId?: string | null
  ownerName?: string | null
  gatewayUrl?: string | null
  lastSeenAt: string
  isOnline: boolean
  isActive: boolean
}

export function listRelays(): Promise<RelayClient[]> {
  return api<RelayClient[]>("/api/relays")
}
