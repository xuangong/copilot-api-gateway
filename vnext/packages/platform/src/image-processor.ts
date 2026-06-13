import { __registerPlatformReset } from "./reset.ts"

export interface CompressOpts {
  maxBytes?: number
  format?: "auto" | "webp" | "jpeg"
}
export interface CompressedImage {
  bytes: Uint8Array
  format: string
  bytesIn: number
  bytesOut: number
}
export interface ImageProcessor {
  compress(input: Uint8Array, opts?: CompressOpts): Promise<CompressedImage>
}

let _ip: ImageProcessor | null = null
__registerPlatformReset(() => { _ip = null })

export function initImageProcessor(ip: ImageProcessor): void {
  _ip = ip
}

export function getImageProcessor(): ImageProcessor {
  if (!_ip) throw new Error("ImageProcessor not initialized; call bootstrap*Platform() first")
  return _ip
}
