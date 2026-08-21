/**
 * A minimal PNG encoder, so the vision matrix can mint fresh unguessable
 * fixtures on every run instead of shipping checked-in images (which a model
 * could plausibly have memorised, and which need a browser to regenerate).
 *
 * Truecolour 8-bit only — that is all the fixtures need, and it keeps the
 * encoder short enough to read in one sitting.
 */

// PNG's IDAT is a zlib (RFC1950) stream, not raw deflate. `Bun.deflateSync`
// emits the raw form, and lenient decoders accept it — but upstream image
// validators reject the file outright, so go through node:zlib instead.
import { deflateSync } from 'node:zlib'

const SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type)
  const body = new Uint8Array(typeBytes.length + data.length)
  body.set(typeBytes)
  body.set(data, typeBytes.length)

  const out = new Uint8Array(8 + data.length + 4)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  out.set(body, 4)
  view.setUint32(4 + body.length, Bun.hash.crc32(body))
  return out
}

export function encodePng(width: number, height: number, rgb: Uint8Array): Uint8Array {
  const expected = width * height * 3
  if (rgb.length !== expected) {
    throw new Error(`pixel buffer is ${rgb.length} bytes, expected ${expected} bytes`)
  }

  // Every scanline gets a leading filter byte; 0 = None, which compresses
  // fine for flat colour blocks and keeps the encoder trivial.
  const stride = width * 3
  const raw = new Uint8Array(height * (stride + 1))
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    raw.set(rgb.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1)
  }

  const ihdr = new Uint8Array(13)
  const v = new DataView(ihdr.buffer)
  v.setUint32(0, width)
  v.setUint32(4, height)
  ihdr[8] = 8   // bit depth
  ihdr[9] = 2   // colour type: truecolour RGB
  ihdr[10] = 0  // deflate
  ihdr[11] = 0  // adaptive filtering
  ihdr[12] = 0  // no interlace

  const parts = [
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', new Uint8Array(deflateSync(raw))),
    chunk('IEND', new Uint8Array(0)),
  ]
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.length }
  return out
}

export const QUADRANT_COLOURS = {
  red: [0xff, 0x00, 0x00],
  green: [0x00, 0xa0, 0x00],
  blue: [0x00, 0x00, 0xff],
  yellow: [0xff, 0xff, 0x00],
  purple: [0x80, 0x00, 0xff],
  orange: [0xff, 0x88, 0x00],
  black: [0x00, 0x00, 0x00],
  white: [0xff, 0xff, 0xff],
} as const

export type Colour = keyof typeof QUADRANT_COLOURS

/** Quadrants are given clockwise from the top-left: TL, TR, BR, BL. */
export function quadrantPng(quads: readonly [Colour, Colour, Colour, Colour], size = 200): Uint8Array {
  for (const q of quads) {
    if (!(q in QUADRANT_COLOURS)) throw new Error(`unknown colour: ${q}`)
  }
  const half = size >> 1
  const rgb = new Uint8Array(size * size * 3)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Index the quadrant clockwise rather than in row-major order, so the
      // prompt's "clockwise from top-left" matches the array literally.
      const idx = y < half ? (x < half ? 0 : 1) : (x < half ? 3 : 2)
      rgb.set(QUADRANT_COLOURS[quads[idx]!], (y * size + x) * 3)
    }
  }
  return encodePng(size, size, rgb)
}
