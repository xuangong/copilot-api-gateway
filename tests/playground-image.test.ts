import { test, expect, describe } from "bun:test"
import { fileToDataUrl, IMAGE_MAX_BYTES, ImageTooLargeError } from "~/ui/dashboard-app/tabs/models/image"

function makeFile(size: number, mime = "image/png", name = "x.png"): File {
  const bytes = new Uint8Array(size)
  return new File([bytes], name, { type: mime })
}

describe("fileToDataUrl", () => {
  test("4 MB image returns data:image/png;base64,…", async () => {
    const url = await fileToDataUrl(makeFile(4 * 1024 * 1024, "image/png"))
    expect(url.startsWith("data:image/png;base64,")).toBe(true)
  })

  test("6 MB image throws ImageTooLargeError", async () => {
    await expect(fileToDataUrl(makeFile(6 * 1024 * 1024))).rejects.toBeInstanceOf(ImageTooLargeError)
  })

  test("IMAGE_MAX_BYTES is 5 MB", () => {
    expect(IMAGE_MAX_BYTES).toBe(5 * 1024 * 1024)
  })
})
