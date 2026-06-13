export const IMAGE_MAX_BYTES = 5 * 1024 * 1024

export class ImageTooLargeError extends Error {
  constructor() {
    super("Image too large (max 5 MB)")
    this.name = "ImageTooLargeError"
  }
}

// Browser/clipboard `file.type` is not authoritative — e.g. a screenshot
// pasted as PNG bytes can arrive with type "image/webp". Anthropic rejects
// mismatched media_type vs. actual bytes with a 400, so sniff magic bytes
// and override the declared mime.
function sniffImageMime(bytes: Uint8Array): string | null {
  if (bytes.length >= 8 &&
      bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png"
  if (bytes.length >= 3 &&
      bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg"
  if (bytes.length >= 6 &&
      bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif"
  if (bytes.length >= 12 &&
      bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp"
  return null
}

export async function fileToDataUrl(file: File): Promise<string> {
  if (file.size > IMAGE_MAX_BYTES) {
    throw new ImageTooLargeError()
  }
  const buf = await file.arrayBuffer()
  const bytes = new Uint8Array(buf)
  // Encode to base64 in chunks to avoid stack blowup on large strings.
  let binary = ""
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  const base64 = typeof btoa !== "undefined"
    ? btoa(binary)
    : Buffer.from(bytes).toString("base64")
  const mime = sniffImageMime(bytes) ?? (file.type || "application/octet-stream")
  return `data:${mime};base64,${base64}`
}
