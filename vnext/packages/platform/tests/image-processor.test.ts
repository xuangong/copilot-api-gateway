import { test, expect, beforeEach } from "bun:test"
import {
  initImageProcessor,
  getImageProcessor,
  type ImageProcessor,
} from "../src/image-processor.ts"
import { __resetPlatformForTests } from "../src/reset.ts"

beforeEach(() => __resetPlatformForTests())

const stub: ImageProcessor = {
  compress: async (input) => ({
    bytes: input,
    format: "webp",
    bytesIn: input.byteLength,
    bytesOut: input.byteLength,
  }),
}

test("getImageProcessor throws before init", () => {
  expect(() => getImageProcessor()).toThrow(/ImageProcessor not initialized/)
})

test("init/get round-trip", () => {
  initImageProcessor(stub)
  expect(getImageProcessor()).toBe(stub)
})
