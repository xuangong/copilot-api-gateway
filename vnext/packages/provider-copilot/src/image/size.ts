/**
 * Image-size fitting helper — verbatim copy from
 * apps/gateway/src/shared/image/size.ts.
 */
import type { ImageDimensions } from "./types"

export interface SizeCaps {
  maxLongEdge?: number
  maxShortEdge?: number
  maxArea?: number
}

/**
 * Scales `source` DOWN (never up) to satisfy every present cap while
 * preserving aspect ratio. Mirrors the server-side downscale providers apply
 * to images, so we never ship pixels the model would discard. With no caps,
 * source passes through unchanged.
 */
export const fitWithin = ({ width, height }: ImageDimensions, caps: SizeCaps): ImageDimensions => {
  const longEdge = Math.max(width, height)
  const shortEdge = Math.min(width, height)
  const factors = [1]
  if (caps.maxLongEdge !== undefined) factors.push(caps.maxLongEdge / longEdge)
  if (caps.maxShortEdge !== undefined) factors.push(caps.maxShortEdge / shortEdge)
  if (caps.maxArea !== undefined) factors.push(Math.sqrt(caps.maxArea / (width * height)))
  const scale = Math.min(...factors)
  if (scale >= 1) return { width, height }
  return { width: Math.round(width * scale), height: Math.round(height * scale) }
}
