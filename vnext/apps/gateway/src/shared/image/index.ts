import type { ImageProcessor } from "./types"

let _imageProcessor: ImageProcessor | null = null

export function initImageProcessor(processor: ImageProcessor): void {
  _imageProcessor = processor
}

export function getImageProcessor(): ImageProcessor {
  if (!_imageProcessor) {
    throw new Error("Image processor not initialized — call initImageProcessor() first")
  }
  return _imageProcessor
}

export function hasImageProcessor(): boolean {
  return _imageProcessor !== null
}

export type { ImageProcessor, ImageDimensions, ImageSizeCalculator } from "./types"
export { createInMemoryImageProcessor } from "./memory"
export {
  createCloudflareImageProcessor,
  type ImagesBinding,
  type ImageCacheKv,
} from "./cloudflare"
export { fitWithin, type SizeCaps } from "./size"
export {
  isBase64ImageDataUrl,
  compressBase64ImageToWebp,
  compressImageDataUrlToWebp,
} from "./inline"
