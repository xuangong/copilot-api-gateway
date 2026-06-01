export const IMAGE_MAX_BYTES = 5 * 1024 * 1024

export class ImageTooLargeError extends Error {
  constructor() {
    super("Image too large (max 5 MB)")
    this.name = "ImageTooLargeError"
  }
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
  const mime = file.type || "application/octet-stream"
  return `data:${mime};base64,${base64}`
}
