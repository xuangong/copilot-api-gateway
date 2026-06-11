/**
 * Image processor IoC singleton — package-local copy of the surface in
 * apps/gateway/src/shared/image/index.ts.
 *
 * Only `getImageProcessor` / `initImageProcessor` / `hasImageProcessor` are
 * ported here because the Copilot data plane (inline.ts) reads through the
 * singleton at request time. The platform-specific encoders
 * (createCloudflareImageProcessor, createInMemoryImageProcessor) stay in
 * gateway — they are wired at boot, not in the request path, and the gateway
 * keeps owning that registration.
 *
 * IMPORTANT (T6 wire-up): the gateway boot path must also call
 * `initImageProcessor` from this package after constructing the runtime
 * processor, otherwise Copilot's compress-inline-images interceptor will
 * throw "Image processor not initialized". Until T6, the duplicate import
 * is a no-op (no caller inside the package yet reaches this surface at
 * request time).
 */
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
export { fitWithin, type SizeCaps } from "./size"
export {
  isBase64ImageDataUrl,
  compressBase64ImageToWebp,
  compressImageDataUrlToWebp,
} from "./inline"
