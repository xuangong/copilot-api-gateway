import { compressInlineImagesChatCompletions } from "../../../../transforms/compress-inline-images"
import type { CopilotInterceptor } from "../../../../interceptors/runner"

/**
 * Recompress inline base64 images in /chat/completions payloads to WebP.
 * Same byte-savings rationale as the messages and responses variants.
 */
export const withInlineImagesCompressed: CopilotInterceptor = async (inv, _ctx, run) => {
  if (inv.enabledFlags.has("transform-compress-inline-images")) {
    await compressInlineImagesChatCompletions(
      inv.payload as { messages?: Array<{ content?: unknown }> },
      inv.payload.model as string,
    )
  }
  return run()
}
