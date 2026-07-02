/**
 * Inline-image transform helpers for Copilot. The encoder seam itself —
 * `ImageProcessor` + `initImageProcessor` / `getImageProcessor` /
 * `hasImageProcessor` — lives in `@vibe-core/platform` because it is a
 * runtime resource on equal footing with the SQL / KV / file bindings.
 * This barrel re-exports just the Copilot-side helpers: data-URL detection,
 * base64 round-trip with the platform processor, and the pure size-fit
 * math.
 */
export { fitWithin, type SizeCaps } from "./size"
export {
  isBase64ImageDataUrl,
  compressBase64ImageToWebp,
  compressImageDataUrlToWebp,
} from "./inline"
