import type { CopilotInterceptor } from "@vnext/interceptor"
import { withCacheControlMarkersAttached } from "./with-cache-control-markers-attached"
import { withChatCompletionsVisionHeader } from "./with-vision-header"
import { withInlineImagesCompressed } from "./with-inline-images-compressed"

export const chatCompletionsPayloadInterceptors: readonly CopilotInterceptor[] = [
  withCacheControlMarkersAttached,
  withChatCompletionsVisionHeader,
  withInlineImagesCompressed,
]
