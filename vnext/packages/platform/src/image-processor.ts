import { __registerPlatformReset } from "./reset.ts"

export interface ImageDimensions {
  width: number
  height: number
}

export type ImageSizeCalculator = (source: ImageDimensions) => ImageDimensions

export interface ImageProcessor {
  compressToWebp(input: Uint8Array, targetSize: ImageSizeCalculator): Promise<Uint8Array>
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
