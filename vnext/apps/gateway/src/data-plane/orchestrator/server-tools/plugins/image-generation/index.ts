/**
 * image_generation plugin entry — Week 4b-4.
 *
 * Currently exposes a single-turn route helper + `hasImageGeneration` guard
 * matching the web-search pattern. The ServerToolPlugin 3-tuple registration
 * lands when orchestrator/loop.ts grows real ReAct dispatch.
 */
export {
  hasImageGeneration,
  validateImageGenerationConfig,
  extractPromptFromInput,
  collectImageSources,
  editSupportedMime,
  decodeInlineImage,
  buildGenerationsBody,
  buildEditsForm,
  generateImageViaBinding,
  buildImageGenerationResponse,
  synthImageGenerationSSE,
  synthesizeImageGenerationCallId,
  synthesizeResponseId,
  SHIM_TOOL_NAME,
  DEFAULT_IMAGE_MODEL,
} from './core.ts'
export type {
  ImageGenerationConfig,
  ImageGenerationConfigError,
  ImageGenerationConfigResult,
  ImageGenerationError,
  ImageGenerationOutcome,
  ImageGenerationResponseShape,
  ImageSource,
} from './core.ts'

export { handleResponsesImageGeneration } from './route-handler.ts'
export type { ImageGenerationRouteContext } from './route-handler.ts'
