import { describe, expect, it } from 'bun:test'
// node:zlib, not `Bun.inflateSync` — the latter reads raw deflate only, which
// is precisely how the missing zlib wrapper slipped through the first time.
import { inflateSync } from 'node:zlib'
import { encodePng, quadrantPng, QUADRANT_COLOURS } from './png'

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** Walks the chunk list so the tests read structure, not byte offsets. */
function chunks(png: Uint8Array) {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  const out: Array<{ type: string; data: Uint8Array; crcOk: boolean }> = []
  let at = 8
  while (at < png.length) {
    const len = view.getUint32(at)
    const type = new TextDecoder().decode(png.subarray(at + 4, at + 8))
    const data = png.subarray(at + 8, at + 8 + len)
    const declared = view.getUint32(at + 8 + len)
    const actual = Bun.hash.crc32(png.subarray(at + 4, at + 8 + len))
    out.push({ type, data, crcOk: declared === actual })
    at += 12 + len
  }
  return out
}

describe('encodePng', () => {
  it('starts with the PNG signature', () => {
    expect([...encodePng(1, 1, new Uint8Array([1, 2, 3]))].slice(0, 8)).toEqual(SIGNATURE)
  })

  it('emits IHDR, IDAT and IEND in order', () => {
    expect(chunks(encodePng(2, 2, new Uint8Array(12))).map((c) => c.type))
      .toEqual(['IHDR', 'IDAT', 'IEND'])
  })

  it('writes a valid CRC for every chunk', () => {
    expect(chunks(encodePng(3, 2, new Uint8Array(18))).every((c) => c.crcOk)).toBe(true)
  })

  it('records the requested dimensions as 8-bit truecolour', () => {
    const ihdr = chunks(encodePng(7, 5, new Uint8Array(105)))[0]!.data
    const v = new DataView(ihdr.buffer, ihdr.byteOffset, ihdr.byteLength)
    expect(v.getUint32(0)).toBe(7)
    expect(v.getUint32(4)).toBe(5)
    expect(ihdr[8]).toBe(8)  // bit depth
    expect(ihdr[9]).toBe(2)  // colour type: truecolour RGB
  })

  it('round-trips the pixels through the IDAT stream', () => {
    const rgb = new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 9, 9, 9])
    const idat = chunks(encodePng(2, 2, rgb))[1]!.data
    const raw = new Uint8Array(inflateSync(idat))
    // Each scanline is prefixed with filter type 0.
    expect([...raw]).toEqual([0, 255, 0, 0, 0, 255, 0, 0, 0, 0, 255, 9, 9, 9])
  })

  // Regression: the encoder first shipped raw deflate. Lenient decoders (and
  // `Bun.inflateSync`, which sniffs) accepted it, so the round-trip test above
  // passed while upstreams rejected the file as "not a valid image".
  it('wraps IDAT in a zlib stream, as the PNG spec requires', () => {
    const idat = chunks(encodePng(2, 2, new Uint8Array(12)))[1]!.data
    const cmf = idat[0]!, flg = idat[1]!
    expect(cmf & 0x0f).toBe(8)                      // compression method: deflate
    expect(((cmf << 8) | flg) % 31).toBe(0)         // zlib header checksum
  })

  // Pins the CRC to the value the spec gives for an empty IEND, so swapping in
  // a differently-parameterised crc32 can't go unnoticed.
  it('computes chunk CRCs the way the PNG spec defines them', () => {
    const png = encodePng(1, 1, new Uint8Array(3))
    const iend = png.subarray(png.length - 12)
    expect(new DataView(iend.buffer, iend.byteOffset).getUint32(8)).toBe(0xae426082)
  })

  it('rejects a buffer that does not match the dimensions', () => {
    expect(() => encodePng(2, 2, new Uint8Array(3))).toThrow(/expected 12 bytes/)
  })
})

describe('quadrantPng', () => {
  /** Reads one pixel back out of the encoded image. */
  function pixelAt(png: Uint8Array, x: number, y: number, width: number) {
    const raw = new Uint8Array(inflateSync(chunks(png)[1]!.data))
    const stride = width * 3 + 1
    const at = y * stride + 1 + x * 3
    return [raw[at], raw[at + 1], raw[at + 2]]
  }

  it('paints the four quadrants clockwise from the top-left', () => {
    const png = quadrantPng(['red', 'green', 'blue', 'yellow'], 4)
    expect(pixelAt(png, 0, 0, 4)).toEqual(QUADRANT_COLOURS.red)
    expect(pixelAt(png, 3, 0, 4)).toEqual(QUADRANT_COLOURS.green)
    expect(pixelAt(png, 3, 3, 4)).toEqual(QUADRANT_COLOURS.blue)
    expect(pixelAt(png, 0, 3, 4)).toEqual(QUADRANT_COLOURS.yellow)
  })

  it('rejects an unknown colour name', () => {
    expect(() => quadrantPng(['red', 'green', 'blue', 'chartreuse' as never], 4))
      .toThrow(/chartreuse/)
  })
})
