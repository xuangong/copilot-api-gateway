export function formatLokiPairing(value: unknown, expectedOrigin: string): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid pairing document")
  const source = value as Record<string, unknown>
  const { version, gatewayOrigin, upstreamId, profileId, generation, syncSecret } = source
  if (version !== 1 || profileId !== "loki-df-v1" || typeof gatewayOrigin !== "string"
    || typeof upstreamId !== "string" || !/^[a-zA-Z0-9_-]{1,256}$/.test(upstreamId)
    || typeof generation !== "string" || !generation || generation.length > 128
    || typeof syncSecret !== "string" || !/^lks_[a-f0-9]{64}$/.test(syncSecret)) throw new Error("Invalid pairing document")
  const origin = new URL(gatewayOrigin)
  if (origin.protocol !== "https:" || origin.origin !== expectedOrigin || gatewayOrigin !== origin.origin
    || origin.username || origin.password) throw new Error("Pairing requires this gateway's HTTPS origin")
  return JSON.stringify({ version, gatewayOrigin, upstreamId, profileId, generation, syncSecret }, null, 2)
}
