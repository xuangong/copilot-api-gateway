import { jsonSnapshotByteChunks } from "./json-ext-traversal"
import { snapshotKnownData } from "./json-snapshot"

const MAX_CHUNK_BYTES = 65536
const encoder = new TextEncoder()

export interface ReplayableJsonBody {
  readonly mode: "native-buffered" | "trusted-json-snapshot"
  readonly contentLength: number
  open(signal?: AbortSignal): ReadableStream<Uint8Array>
}

const nativeChunks = function* (bytes: Uint8Array): Generator<Uint8Array> {
  for (let offset = 0; offset < bytes.byteLength; offset += MAX_CHUNK_BYTES) {
    yield bytes.slice(offset, Math.min(offset + MAX_CHUNK_BYTES, bytes.byteLength))
  }
}

function makeBody(mode: ReplayableJsonBody["mode"], contentLength: number, chunks: () => Generator<Uint8Array>): ReplayableJsonBody {
  return Object.freeze({
    mode,
    contentLength,
    open(signal?: AbortSignal): ReadableStream<Uint8Array> {
      let iterator: Generator<Uint8Array> | undefined
      let controller: ReadableStreamDefaultController<Uint8Array> | undefined
      let ended = false
      const cleanup = () => {
        if (ended) return
        ended = true
        signal?.removeEventListener("abort", onAbort)
        iterator?.return(undefined)
        iterator = undefined
      }
      const onAbort = () => {
        if (ended) return
        cleanup()
        controller?.error(signal?.reason ?? new DOMException("Aborted", "AbortError"))
      }
      return new ReadableStream<Uint8Array>({
        start(streamController) {
          controller = streamController
          if (signal?.aborted) onAbort()
          else signal?.addEventListener("abort", onAbort, { once: true })
        },
        pull(streamController) {
          if (ended) return
          try {
            iterator ??= chunks()
            const result = iterator.next()
            if (result.done) {
              cleanup()
              streamController.close()
            } else {
              streamController.enqueue(result.value)
            }
          } catch (error) {
            cleanup()
            streamController.error(error)
          }
        },
        cancel() { cleanup() }
      }, { highWaterMark: 0 })
    }
  })
}

export function createJsonBody(value: unknown): ReplayableJsonBody {
  const text = JSON.stringify(value)
  if (text === undefined) throw new TypeError("No JSON representation")
  const bytes = encoder.encode(text)
  return makeBody("native-buffered", bytes.byteLength, () => nativeChunks(bytes))
}

export function createJsonBodyFromText(text: string): ReplayableJsonBody {
  if (typeof text !== "string") throw new TypeError("Expected JSON text")
  const snapshot = snapshotKnownData(JSON.parse(text))
  let contentLength = 0
  for (const chunk of jsonSnapshotByteChunks(snapshot)) {
    contentLength += chunk.byteLength
    if (!Number.isSafeInteger(contentLength)) throw new RangeError("JSON body length exceeds safe integer")
  }
  return makeBody("trusted-json-snapshot", contentLength, () => jsonSnapshotByteChunks(snapshot))
}
