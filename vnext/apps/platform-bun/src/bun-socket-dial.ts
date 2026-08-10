// Bun SocketDial impl. Ported from copilot-gateway's platform-node —
// Bun has full node:net + node:tls API compatibility, so we reuse the
// battle-tested Node adapter here rather than reimplementing with
// Bun.connect(). Behaviour and comments preserved verbatim.

import net from "node:net"
import { Readable } from "node:stream"
import tls from "node:tls"

import {
  normalizeDialHost,
  throwAbort,
  type DialedSocket,
  type SocketDial,
} from "@vibe-core/platform"

// Hand-rolled adapter from a node:net.Socket to a WritableStream<Uint8Array>.
// Writable.toWeb only wires `close()` to socket.end(); writer.abort() is
// routed through the same end-of-stream path and leaves the underlying
// socket alive in a half-open state. Our proxy runners depend on
// cancellation actually destroying the socket so the inner-TLS stack
// stops trying to drain a dead leg.
const socketToWritable = (socket: net.Socket): WritableStream<Uint8Array> => {
  let controller: WritableStreamDefaultController | null = null
  const onError = (err: Error): void => { controller?.error(err) }
  socket.on("error", onError)
  socket.once("close", () => { socket.off("error", onError) })
  return new WritableStream<Uint8Array>({
    start(c) { controller = c },
    write(chunk) {
      return new Promise<void>((resolve, reject) => {
        socket.write(chunk, err => {
          if (err) reject(err)
          else resolve()
        })
      })
    },
    close() {
      return new Promise<void>(resolve => {
        socket.end(() => resolve())
      })
    },
    abort(reason) {
      const err = reason instanceof Error ? reason : new Error(String(reason ?? "aborted"))
      socket.destroy(err)
    },
  })
}

export const bunSocketDial: SocketDial = {
  async connect(host, port, opts): Promise<DialedSocket> {
    if (opts?.signal?.aborted) throwAbort(opts.signal)
    const dialHost = normalizeDialHost(host)
    const signal = opts?.signal
    const socket = opts?.tls
      // @ts-expect-error – tls.connect honours signal at runtime but @types/node hasn't surfaced it on ConnectionOptions
      ? tls.connect({ host: dialHost, port, servername: dialHost, signal })
      : net.connect({ host: dialHost, port, allowHalfOpen: true, signal })
    const readyEvent = opts?.tls ? "secureConnect" : "connect"
    await new Promise<void>((resolve, reject) => {
      const onReady = (): void => {
        socket.off("error", onError)
        resolve()
      }
      const onError = (err: Error): void => {
        socket.off(readyEvent, onReady)
        reject(err)
      }
      socket.once(readyEvent, onReady)
      socket.once("error", onError)
    })

    // net.Socket recycles emitted Buffers from a shared pool; copy on the way out.
    const rawReadable = Readable.toWeb(socket) as unknown as ReadableStream<Uint8Array>
    const readable = rawReadable.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        const owned = new Uint8Array(chunk.byteLength)
        owned.set(chunk)
        controller.enqueue(owned)
      },
    }))
    const writable = socketToWritable(socket)

    const closed = new Promise<void>(resolve => {
      socket.once("close", () => resolve())
    })

    // Permanent 'error' listener prevents Node/Bun from escalating post-connect errors.
    socket.on("error", err => {
      if (process.env.FLOWAY_DEBUG_SOCKET) {
        console.debug("[socket-dial] post-connect error:", err)
      }
    })

    if (opts?.signal) {
      const captured = opts.signal
      const onAbort = (): void => { socket.destroy() }
      captured.addEventListener("abort", onAbort, { once: true })
      socket.once("close", () => {
        captured.removeEventListener("abort", onAbort)
      })
      // Close TOCTOU: fire onAbort synchronously if signal aborted between
      // pre-check and listener install.
      if (captured.aborted) onAbort()
    }

    return {
      readable,
      writable,
      close: async () => {
        socket.destroy()
        await closed
      },
    }
  },
}
