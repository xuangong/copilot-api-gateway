import { getImageProcessor } from "./index"
import type { ImageSizeCalculator } from "./types"

const BASE64_CHUNK = 0x8000

const base64ToBytes = (base64: string): Uint8Array => {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = ""
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK))
  }
  return btoa(binary)
}

/** Recompresses a raw base64 image payload (no data: prefix) to base64 WebP. */
export const compressBase64ImageToWebp = async (
  base64: string,
  targetSize: ImageSizeCalculator,
): Promise<string> => {
  const webp = await getImageProcessor().compressToWebp(base64ToBytes(base64), targetSize)
  return bytesToBase64(webp)
}

const BASE64_DATA_URL = /^data:([^;,]+);base64,(.*)$/s

export const isBase64ImageDataUrl = (url: string): boolean =>
  BASE64_DATA_URL.exec(url)?.[1]?.startsWith("image/") ?? false

/**
 * Recompresses a `data:image/*;base64,...` URL to a WebP data URL. Returns
 * the original URL unchanged when it is not a base64 image data URL (e.g. a
 * remote https image reference, which the gateway forwards as-is).
 */
export const compressImageDataUrlToWebp = async (
  url: string,
  targetSize: ImageSizeCalculator,
): Promise<string> => {
  const match = BASE64_DATA_URL.exec(url)
  const mediaType = match?.[1]
  const data = match?.[2]
  if (!mediaType?.startsWith("image/") || data === undefined) return url
  const webp = await compressBase64ImageToWebp(data, targetSize)
  return `data:image/webp;base64,${webp}`
}
