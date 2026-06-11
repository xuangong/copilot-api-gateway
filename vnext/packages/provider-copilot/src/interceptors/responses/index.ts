import type { CopilotInterceptor } from "@vnext/interceptor"
import { withStoreForcedFalse } from "./with-store-forced-false"
import { withImageGenerationStripped } from "./with-image-generation-stripped"
import { withSafetyIdentifierStripped } from "./with-safety-identifier-stripped"
import { withResponsesVisionHeader } from "./with-vision-header"
import { withInlineImagesCompressed } from "./with-inline-images-compressed"

export const responsesPayloadInterceptors: readonly CopilotInterceptor[] = [
  withStoreForcedFalse,
  withImageGenerationStripped,
  withSafetyIdentifierStripped,
  withResponsesVisionHeader,
  withInlineImagesCompressed,
]
