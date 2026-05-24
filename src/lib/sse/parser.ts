/**
 * Unified SSE frame parser.
 *
 * A "frame" is the text up to and including a `\n\n` (or `\r\n\r\n`)
 * blank-line terminator. This parser:
 *   - buffers partial chunks across TransformStream transform() calls
 *   - emits whole frames only
 *   - parses each frame into `event`, `data`, `id`, `retry` (per W3C EventSource spec subset)
 *   - preserves the original raw frame text so re-serialization is byte-identical
 *
 * Two consumers in this codebase:
 *   - `createSSELineTransform` (line-based, drops everything except `data:` lines)
 *   - `createSSEFrameTransform` (frame-aware, supports event/data/comment)
 *
 * Both build on top of `parseFrames` for the parsing layer.
 */

export interface SSEFrame {
  /** Raw frame text including terminator — round-trippable. */
  raw: string
  /** Value of the `event:` line, if present. */
  event?: string
  /** Concatenated `data:` line values (multi-line data per spec). */
  data?: string
  /** Value of the `id:` line, if present. */
  id?: string
  /** Value of the `retry:` line, if present (ms). */
  retry?: number
}

/**
 * Parse a string already containing one or more whole frames.
 * Callers are responsible for chunk-boundary buffering — use
 * `createFrameBuffer()` for that.
 */
export function parseFrames(text: string): SSEFrame[] {
  const frames: SSEFrame[] = []
  let i = 0
  while (i < text.length) {
    let termIdx = -1
    let termLen = 0
    for (let j = i; j < text.length - 1; j++) {
      if (text[j] === "\n" && text[j + 1] === "\n") {
        termIdx = j
        termLen = 2
        break
      }
      if (
        j + 3 < text.length
        && text[j] === "\r" && text[j + 1] === "\n"
        && text[j + 2] === "\r" && text[j + 3] === "\n"
      ) {
        termIdx = j
        termLen = 4
        break
      }
    }
    if (termIdx === -1) {
      frames.push({ raw: text.slice(i) })
      break
    }
    const raw = text.slice(i, termIdx + termLen)
    const inner = text.slice(i, termIdx)
    const frame: SSEFrame = { raw }
    for (const line of inner.split(/\r?\n/)) {
      if (line.startsWith("event:")) frame.event = line.slice(6).trim()
      else if (line.startsWith("data:")) frame.data = (frame.data ?? "") + line.slice(5).trimStart()
      else if (line.startsWith("id:")) frame.id = line.slice(3).trim()
      else if (line.startsWith("retry:")) {
        const n = Number(line.slice(6).trim())
        if (Number.isFinite(n)) frame.retry = n
      }
    }
    frames.push(frame)
    i = termIdx + termLen
  }
  return frames
}

/**
 * Try to parse `frame.data` as JSON. Returns undefined on parse failure.
 */
export function parseDataJSON<T = unknown>(frame: SSEFrame): T | undefined {
  if (!frame.data) return undefined
  try {
    return JSON.parse(frame.data) as T
  } catch {
    return undefined
  }
}

const decoder = new TextDecoder("utf-8", { fatal: false })

/**
 * Stateful frame-boundary buffer. Push chunks in, get whole frames out.
 * Trailing partial frame is held until the next push or `flush()`.
 */
export interface FrameBuffer {
  push(chunk: Uint8Array): SSEFrame[]
  /** Return any remaining buffered text as a frame (no terminator). */
  flush(): SSEFrame | null
}

export function createFrameBuffer(): FrameBuffer {
  let buffer = ""
  return {
    push(chunk: Uint8Array): SSEFrame[] {
      buffer += decoder.decode(chunk, { stream: true })
      const out: SSEFrame[] = []
      // Find the last frame terminator; everything before is whole, everything after is partial.
      let lastTerm = -1
      let lastTermLen = 0
      for (let j = 0; j < buffer.length - 1; j++) {
        if (buffer[j] === "\n" && buffer[j + 1] === "\n") {
          lastTerm = j
          lastTermLen = 2
        } else if (
          j + 3 < buffer.length
          && buffer[j] === "\r" && buffer[j + 1] === "\n"
          && buffer[j + 2] === "\r" && buffer[j + 3] === "\n"
        ) {
          lastTerm = j
          lastTermLen = 4
        }
      }
      if (lastTerm === -1) return out
      const wholeText = buffer.slice(0, lastTerm + lastTermLen)
      buffer = buffer.slice(lastTerm + lastTermLen)
      return parseFrames(wholeText)
    },
    flush(): SSEFrame | null {
      if (!buffer.trim()) {
        buffer = ""
        return null
      }
      const frame: SSEFrame = { raw: buffer }
      for (const line of buffer.split(/\r?\n/)) {
        if (line.startsWith("event:")) frame.event = line.slice(6).trim()
        else if (line.startsWith("data:")) frame.data = (frame.data ?? "") + line.slice(5).trimStart()
      }
      buffer = ""
      return frame
    },
  }
}
