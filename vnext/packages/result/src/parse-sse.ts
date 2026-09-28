import { type SseFrame, sseFrame } from './frame'

export interface ParseSSEStreamOptions {
  signal?: AbortSignal
}

export const parseSSEStream = async function* (
  body: ReadableStream<Uint8Array>,
  options: ParseSSEStreamOptions = {},
): AsyncGenerator<SseFrame> {
  const reader = body.getReader()
  const { signal } = options
  const decoder = new TextDecoder()
  let buffer = ''
  let currentEvent = ''
  let dataLines: string[] = []
  let skipLf = false
  let firstLine = true
  let cancelPromise: Promise<void> | undefined

  const cancelReader = (reason?: unknown): Promise<void> => {
    cancelPromise ??= reader.cancel(reason).catch(() => {})
    return cancelPromise
  }

  const cancelReaderOnAbort = () => { void cancelReader(signal?.reason) }

  const readLine = (rawLine: string): SseFrame | null => {
    const line = firstLine && rawLine.startsWith("\ufeff") ? rawLine.slice(1) : rawLine
    firstLine = false
    if (line === "") {
      const frame = dataLines.length > 0 ? sseFrame(dataLines.join("\n"), currentEvent || undefined) : null
      dataLines = []
      currentEvent = ""
      return frame
    }
    const colon = line.indexOf(":")
    const field = colon < 0 ? line : line.slice(0, colon)
    let value = colon < 0 ? "" : line.slice(colon + 1)
    if (value.startsWith(" ")) value = value.slice(1)
    if (field === "event") currentEvent = value
    if (field === "data") dataLines.push(value)
    return null
  }

  // Recognize CR, LF and split CRLF without buffering a complete event twice.
  function* feed(chunk: string): Generator<SseFrame> {
    let start = 0
    for (let index = 0; index < chunk.length; index++) {
      const char = chunk[index]
      if (skipLf) {
        skipLf = false
        if (char === "\n") { start = index + 1; continue }
      }
      if (char !== "\r" && char !== "\n") continue
      buffer += chunk.slice(start, index)
      const frame = readLine(buffer)
      buffer = ""
      start = index + 1
      skipLf = char === "\r"
      if (frame) yield frame
    }
    buffer += chunk.slice(start)
  }

  if (signal?.aborted) {
    void cancelReader(signal.reason)
    reader.releaseLock()
    return
  }

  signal?.addEventListener('abort', cancelReaderOnAbort, { once: true })

  try {
    while (true) {
      if (signal?.aborted) return
      const { done, value } = await reader.read()
      if (signal?.aborted) return
      if (done) break
      for (const frame of feed(decoder.decode(value, { stream: true }))) {
        if (signal?.aborted) return
        yield frame
      }
    }

    yield* feed(decoder.decode())
    // Keep the established tolerant EOF flush for peers omitting the final blank line.
    if (buffer) readLine(buffer)
    const final = readLine("")
    if (final && !signal?.aborted) yield final
  } finally {
    signal?.removeEventListener('abort', cancelReaderOnAbort)
    try {
      // Abort must not depend on a transport's unbounded cancellation cleanup.
      // cancelReader observes rejection even when we detach from its promise.
      if (signal?.aborted) void cancelReader(signal.reason)
      else await (cancelPromise ?? reader.cancel())
    } finally { reader.releaseLock() }
  }
}
