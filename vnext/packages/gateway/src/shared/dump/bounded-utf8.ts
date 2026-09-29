import { Buffer } from "node:buffer"

const textEncoder = new TextEncoder()
// Bun 1.3 undercounts lone surrogates and splits pairs in short encodeInto
// destinations. Probe once; affected runtimes keep the bounded JS path.
const nativeUtf8Exact = Buffer.byteLength("\ud800", "utf8") === 3
  && textEncoder.encodeInto("😀", new Uint8Array(3)).read === 0
const utf8ByteLength = nativeUtf8Exact
  ? (text: string): number => Buffer.byteLength(text, "utf8")
  : (text: string): number => {
    let total = 0
    for (let index = 0; index < text.length; index++) {
      const point = text.codePointAt(index) ?? 0xfffd
      if (point > 0xffff) { total += 4; index++ }
      else total += point < 0x80 ? 1 : point < 0x800 ? 2 : 3
    }
    return total
  }

function encodePrefixCompat(text: string, prefix: Uint8Array): void {
  let copied = 0
  const write = (value: number) => { if (copied < prefix.byteLength) prefix[copied++] = value }
  for (let index = 0; index < text.length && copied < prefix.byteLength; index++) {
    let point = text.codePointAt(index) ?? 0xfffd
    if (point > 0xffff) index++
    else if (point >= 0xd800 && point <= 0xdfff) point = 0xfffd
    if (point < 0x80) write(point)
    else if (point < 0x800) {
      write(0xc0 | (point >> 6))
      write(0x80 | (point & 0x3f))
    } else if (point < 0x10000) {
      write(0xe0 | (point >> 12))
      write(0x80 | ((point >> 6) & 0x3f))
      write(0x80 | (point & 0x3f))
    } else {
      write(0xf0 | (point >> 18))
      write(0x80 | ((point >> 12) & 0x3f))
      write(0x80 | ((point >> 6) & 0x3f))
      write(0x80 | (point & 0x3f))
    }
  }
}

/** Counts the whole string while materializing only a bounded exact byte prefix. */
export function boundedUtf8(text: string, limit: number): { prefix: Uint8Array; totalBytes: number } {
  // Native counting does not materialize an encoded copy of the whole input.
  const totalBytes = utf8ByteLength(text)
  const prefix = new Uint8Array(Math.min(limit, totalBytes))
  if (!nativeUtf8Exact) { encodePrefixCompat(text, prefix); return { prefix, totalBytes } }
  const { read, written } = textEncoder.encodeInto(text, prefix)
  if (written < prefix.byteLength) {
    // encodeInto stops before an incomplete codepoint. Capture its leading
    // bytes too; two UTF-16 units cover a pair or the replacement of a lone half.
    const tail = textEncoder.encode(text.slice(read, read + 2))
    prefix.set(tail.subarray(0, prefix.byteLength - written), written)
  }
  return { prefix, totalBytes }
}

