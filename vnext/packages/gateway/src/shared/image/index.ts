import {
  initImageProcessor,
  getImageProcessor,
  type ImageProcessor,
  type ImageDimensions,
  type ImageSizeCalculator,
} from "@vnext/platform"

export { initImageProcessor, getImageProcessor }
export type { ImageProcessor, ImageDimensions, ImageSizeCalculator }

export { fitWithin, type SizeCaps } from "./size"
export {
  isBase64ImageDataUrl,
  compressBase64ImageToWebp,
  compressImageDataUrlToWebp,
} from "./inline"
export { createInMemoryImageProcessor } from "./memory"
