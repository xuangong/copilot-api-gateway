/**
 * Whether the selected model can actually accept an image.
 *
 * The upstream's own `capabilities.supports.vision` is the starting point, but
 * it is not reliable: measured against a Copilot upstream on 2026-08-22, five
 * of twenty-six chat models disagreed with their own catalogue entry. So the
 * claim is corrected by a table of models we have actually probed, and the
 * result never hard-disables anything — a wrong flag must not block a model
 * that works.
 *
 * Re-measure with `bun scripts/vision-matrix --key sk_... --capabilities`.
 */

export type VisionSupport =
  /** Vision available. */
  | "yes"
  /** Upstream advertises vision but 400s on every image we send it. */
  | "yes-but-rejected"
  /** No vision. */
  | "no"
  /** Upstream publishes no capability list — say nothing rather than guess. */
  | "unknown"

/**
 * Models whose catalogue entry is wrong, verified end to end by the vision
 * matrix (four distinct colours read back in order, ~1 in 1680 by chance).
 *
 * `true`  — claims no vision, reads images fine.
 * `false` — claims vision, upstream rejects every image with
 *           "validating image item: image media type not supported".
 */
export const VISION_OVERRIDES: Record<string, boolean> = {
  "gpt-4": true,
  "gpt-4-0613": true,
  "gpt-4-0125-preview": true,
  "gpt-4-o-preview": true,
  "gpt-4o": false,
}

export function visionSupport(
  modelId: string,
  supports: Record<string, unknown> | undefined,
): VisionSupport {
  const override = VISION_OVERRIDES[modelId]
  if (override === true) return "yes"
  if (override === false) return "yes-but-rejected"
  if (!supports) return "unknown"
  return supports.vision === true ? "yes" : "no"
}

/**
 * Upstreams refuse images from a non-vision deployment with a message that
 * reads like a validator stack trace. Detect it so the playground can say
 * something a human can act on.
 */
export function isImageRejection(message: string): boolean {
  return /image media type not supported|validating vision content/i.test(message)
}
