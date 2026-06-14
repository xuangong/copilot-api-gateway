import type { ImageProcessor, ImageSizeCalculator } from "@vnext/platform"

/**
 * In-memory image processor for tests and local dev. There is no WebP codec
 * available in pure Bun without a native dep, so this stub returns the input
 * bytes unchanged. It exists only to satisfy the ImageProcessor contract so
 * the inline-image transform can run end-to-end locally; behaviour assertions
 * (which images get rewritten, with which size calculator) belong in
 * dedicated transform tests using a spy processor.
 */
class InMemoryImageProcessor implements ImageProcessor {
  compressToWebp(input: Uint8Array, _targetSize: ImageSizeCalculator): Promise<Uint8Array> {
    return Promise.resolve(input)
  }
}

export const createInMemoryImageProcessor = (): ImageProcessor => new InMemoryImageProcessor()
