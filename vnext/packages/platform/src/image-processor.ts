/**
 * Image processor — a runtime resource on equal footing with the SQL, KV,
 * and file/background bindings. The interface lives in @vibe-core/platform
 * so business packages (provider-copilot's inline-image interceptor, future
 * vision-capable providers) consume it without depending on any particular
 * encoder, and so the platform-* listener apps own the concrete bindings
 * (Cloudflare Images in prod, in-memory stub in Bun/dev).
 *
 * Per the gateway charter §4.1: platform layer = runtime abstraction
 * (env/sql/file/background/image). Inline-image compression itself is
 * LLM-vertical and stays in provider-copilot; only the encoder seam is
 * platform.
 */
import { __registerPlatformReset } from "./reset.ts"

export interface ImageDimensions {
  width: number
  height: number
}

/**
 * Maps a source image's pixel dimensions to the dimensions the compressor
 * should fit the output within. Returned dimensions are an upper bound — the
 * compressor scales down to fit but never enlarges past the source. This is
 * the one intentional knob the caller passes in: per-model tile budgets plug
 * in here without the processor learning any model specifics.
 */
export type ImageSizeCalculator = (source: ImageDimensions) => ImageDimensions

/**
 * Re-encodes raster image bytes to WebP scaled to fit the calculator's
 * target box. Implementations: createCloudflareImageProcessor (production),
 * createInMemoryImageProcessor (Bun/local stub — returns input bytes
 * unchanged so callers can detect a no-op via reference equality).
 */
export interface ImageProcessor {
  compressToWebp(input: Uint8Array, targetSize: ImageSizeCalculator): Promise<Uint8Array>
}

let _imageProcessor: ImageProcessor | null = null
__registerPlatformReset(() => { _imageProcessor = null })

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
