import { test, expect } from "bun:test"
import { dimensionsFromBytes } from "../src/image-processor.ts"

const decode = (base64: string): Uint8Array => {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

// Real 1×1 fixture images. Each carries the canonical magic bytes plus a
// minimal header so image-size's parser reads width/height without decoding
// pixel data.
const PNG_1x1 = decode(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/wEAAAAASUVORK5CYII=",
)
const JPEG_1x1 = decode(
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/2wBDAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAr/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AL+AB//Z",
)
const WEBP_1x1 = decode("UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAEAcQERGIiP4HAA==")

test("dimensionsFromBytes reads PNG dimensions", () => {
  expect(dimensionsFromBytes(PNG_1x1)).toEqual({ width: 1, height: 1 })
})

test("dimensionsFromBytes reads JPEG dimensions", () => {
  expect(dimensionsFromBytes(JPEG_1x1)).toEqual({ width: 1, height: 1 })
})

test("dimensionsFromBytes reads WebP dimensions", () => {
  expect(dimensionsFromBytes(WEBP_1x1)).toEqual({ width: 1, height: 1 })
})

test("dimensionsFromBytes returns null on unparseable bytes", () => {
  expect(dimensionsFromBytes(new Uint8Array([1, 2, 3, 4]))).toBeNull()
})

test("dimensionsFromBytes returns null on an empty buffer", () => {
  expect(dimensionsFromBytes(new Uint8Array())).toBeNull()
})
