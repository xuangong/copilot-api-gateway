import { sha256 } from '@noble/hashes/sha256'

const MAX_UTF16_UNITS = 16 * 1024
const YIELD_AFTER_BYTES = 1024 * 1024
const encoder = new TextEncoder()

const isHighSurrogate = (unit: number): boolean => unit >= 0xd800 && unit <= 0xdbff
const isLowSurrogate = (unit: number): boolean => unit >= 0xdc00 && unit <= 0xdfff

// Parts are semantically concatenated before UTF-8 encoding. Hold a trailing
// high surrogate so a pair split across parts has the same bytes as TextEncoder.
export const sha256Utf8Parts = async (parts: Iterable<string>): Promise<Uint8Array> => {
  const hash = sha256.create()
  let pendingHigh = ''
  let bytesSinceYield = 0
  const update = async (value: string): Promise<void> => {
    const bytes = encoder.encode(value)
    hash.update(bytes)
    bytesSinceYield += bytes.byteLength
    if (bytesSinceYield >= YIELD_AFTER_BYTES) {
      bytesSinceYield = 0
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    }
  }
  for (const part of parts) {
    let start = 0
    if (pendingHigh && part.length > 0) {
      if (isLowSurrogate(part.charCodeAt(0))) {
        await update(pendingHigh + part[0])
        start = 1
      } else {
        await update(pendingHigh)
      }
      pendingHigh = ''
    }
    while (start < part.length) {
      let end = Math.min(part.length, start + MAX_UTF16_UNITS)
      if (end < part.length && isHighSurrogate(part.charCodeAt(end - 1)) && isLowSurrogate(part.charCodeAt(end))) end++
      if (end === part.length && isHighSurrogate(part.charCodeAt(end - 1))) {
        pendingHigh = part[end - 1] ?? ''
        end--
      }
      if (end > start) await update(part.slice(start, end))
      start = end < part.length ? end : part.length
      if (pendingHigh) break
    }
  }
  if (pendingHigh) await update(pendingHigh)
  return hash.digest()
}
