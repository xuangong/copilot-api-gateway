import { compressInlineImagesResponses } from "../../../../transforms/index"
import type { ResponsesPayload } from "../../../../transforms/index"
import type { CopilotInterceptor } from "../../../../interceptors/runner"

/**
 * Recompress inline base64 images in /responses payloads to WebP.
 *
 * Mirrors the messages variant (withInlineImagesCompressed) but operates on
 * the Responses `input` array shape — image parts live under
 * `content[].image_url` (type: "input_image") on message items and under
 * `output[].image_url` on function_call_output items.
 *
 * Reused by the count_tokens chain (Task 8) so token estimates match the
 * bytes we actually ship — otherwise count_tokens reports too high for any
 * client that sends raw PNG/JPEG inline.
 */
export const withInlineImagesCompressed: CopilotInterceptor = async (inv, _ctx, run) => {
  if (inv.enabledFlags.has("transform-compress-inline-images")) {
    await compressInlineImagesResponses(
      inv.payload as unknown as ResponsesPayload,
      inv.payload.model as string,
    )
  }
  return run()
}
