import { compressInlineImagesMessages } from "../../transforms/compress-inline-images"
import type { AnthropicMessagesPayload } from "../../transforms"
import type { CopilotInterceptor } from "@vibe-llm/protocols/common"

/**
 * Recompress inline base64 images in /v1/messages payloads to WebP.
 *
 * Reused by the count_tokens chain (Task 8) so token estimates match the
 * bytes we actually ship — otherwise count_tokens reports too high for any
 * client that sends raw PNG/JPEG inline.
 */
export const withInlineImagesCompressed: CopilotInterceptor = async (inv, _ctx, run) => {
  if (inv.enabledFlags.has("transform-compress-inline-images")) {
    await compressInlineImagesMessages(
      inv.payload as unknown as AnthropicMessagesPayload,
      inv.payload.model as string,
    )
  }
  return run()
}
