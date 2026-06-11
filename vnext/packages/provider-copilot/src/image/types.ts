/**
 * Image processor types — verbatim copy from
 * apps/gateway/src/shared/image/types.ts. Both sides keep their own copy
 * because the type lives at the contract between Copilot transforms and
 * whatever encoder ships with the runtime (Cloudflare Images binding in
 * prod, in-memory stub in tests). Structural duplication only — semantics
 * cannot drift.
 */
export interface ImageDimensions {
  width: number
  height: number
}

/**
 * Maps a source image's pixel dimensions to the dimensions the compressor
 * should fit the output within. Returned dimensions are an upper bound — the
 * compressor scales down to fit but never enlarges past the source. This is
 * the one intentional knob the caller passes in: per-model tile budgets plug
 * in here (see ./size.ts) without the processor learning any model specifics.
 */
export type ImageSizeCalculator = (source: ImageDimensions) => ImageDimensions

/**
 * Global image-recompression service, structured like the data Repo: one
 * abstract surface with a per-platform implementation chosen at the entry
 * point (Cloudflare Images binding in production, an in-memory stub in
 * tests/local). Callers reach it through getImageProcessor(); they never
 * pass the compression strategy itself around — only the size calculator.
 */
export interface ImageProcessor {
  /**
   * Re-encodes arbitrary raster image bytes to WebP at a fixed internal
   * quality, scaled to fit the calculator's target box. Throws if the bytes
   * cannot be decoded as an image; that failure is surfaced, not masked.
   */
  compressToWebp(input: Uint8Array, targetSize: ImageSizeCalculator): Promise<Uint8Array>
}
