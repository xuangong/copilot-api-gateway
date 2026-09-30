import { Buffer } from "node:buffer"

// Older Bun versions undercount lone surrogates. Keep TextEncoder's replacement
// semantics without allocating the encoded body on affected runtimes.
export const utf8ByteLength = Buffer.byteLength("\ud800", "utf8") === 3
  ? (text: string): number => Buffer.byteLength(text, "utf8")
  : (text: string): number => {
    let bytes = 0
    for (let index = 0; index < text.length; index++) {
      const point = text.codePointAt(index) ?? 0xfffd
      if (point > 0xffff) { bytes += 4; index++ }
      else bytes += point < 0x80 ? 1 : point < 0x800 ? 2 : 3
    }
    return bytes
  }
