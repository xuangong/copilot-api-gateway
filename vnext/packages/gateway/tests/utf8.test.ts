import { expect, test } from "bun:test"
import { utf8ByteLength } from "../src/shared/utf8.ts"

test("UTF-8 length matches TextEncoder including malformed UTF-16", () => {
  const encoder = new TextEncoder()
  const cases = ["", "ASCII\0\r\n", "你好😀", "\ufeff", "\ud800", "\udfff", "\ud800x\udc00", "\ud800\ud800\udc00\udc00", "\u07ff\u0800\uffff"]
  for (let offset = 0; offset < 0x10000; offset += 256) {
    cases.push(String.fromCharCode(...Array.from({ length: 256 }, (_, index) => offset + index)))
  }
  for (const value of cases) expect(utf8ByteLength(value)).toBe(encoder.encode(value).byteLength)
})
