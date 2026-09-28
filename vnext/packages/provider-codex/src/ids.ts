import { sha256Utf8Parts } from '@vibe-llm/provider-llm'

const MAX_WEBCRYPTO_PART_UNITS = 2 * 1024 * 1024

// Format the SHA-256 digest as a UUIDv4-shaped opaque identifier. This remains
// for gateway-owned stable ids where we intentionally do not mimic Codex's
// random persisted device id yet.
export const sha256Uuid = async (input: string): Promise<string> => {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return uuidFromSha256(new Uint8Array(buf))
}

export const sha256UuidFromParts = async (parts: readonly string[]): Promise<string> => {
  let units = 0
  for (const part of parts) {
    units += part.length
    if (units > MAX_WEBCRYPTO_PART_UNITS) break
  }
  // This exception caps the joined string at 2 Mi UTF-16 units and its
  // TextEncoder buffer at 6 MiB; larger seeds keep the bounded chunk path.
  if (units <= MAX_WEBCRYPTO_PART_UNITS) return await sha256Uuid(parts.join(''))
  return uuidFromSha256(await sha256Utf8Parts(parts))
}

const uuidFromSha256 = (digest: Uint8Array): string => {
  const hex = Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('')
  const variantNibble = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variantNibble}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

export const uuidV7 = (): string => {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)

  const timestampMs = BigInt(Date.now())
  bytes[0] = Number((timestampMs >> 40n) & 0xffn)
  bytes[1] = Number((timestampMs >> 32n) & 0xffn)
  bytes[2] = Number((timestampMs >> 24n) & 0xffn)
  bytes[3] = Number((timestampMs >> 16n) & 0xffn)
  bytes[4] = Number((timestampMs >> 8n) & 0xffn)
  bytes[5] = Number(timestampMs & 0xffn)
  bytes[6] = (bytes[6]! & 0x0f) | 0x70
  bytes[8] = (bytes[8]! & 0x3f) | 0x80

  return uuidFromBytes(bytes)
}

const uuidFromBytes = (bytes: Uint8Array): string => {
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0'))
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`
}
