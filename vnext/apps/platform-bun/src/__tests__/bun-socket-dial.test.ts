import { describe, expect, it } from "bun:test"
import net from "node:net"
import { fetchOnStream } from "../../../../packages/http/src/fetch-on-stream.ts"
import type { ReplayableBody } from "../../../../packages/platform/src/replayable-body.ts"
import { bunSocketDial } from "../bun-socket-dial.ts"

describe("bunSocketDial writable", () => {
  for (const termination of ["close", "abort"] as const) {
    it(`rejects a pending write when ${termination} drops its callback`, async () => {
      let accepted: net.Socket | undefined
      const server = net.createServer(socket => { accepted = socket })
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("missing port")

      const originalWrite = net.Socket.prototype.write
      let intercepted!: () => void
      const started = new Promise<void>(resolve => { intercepted = resolve })
      let lateCallback: (() => void) | undefined
      net.Socket.prototype.write = function (...args: unknown[]): boolean {
        if (this.remotePort === address.port) {
          const index = args.findIndex(value => typeof value === "function")
          if (index < 0) throw new Error("expected a socket write callback")
          lateCallback = args[index] as () => void
          args[index] = () => {}
          intercepted()
        }
        return originalWrite.apply(this, args as Parameters<typeof originalWrite>)
      }

      try {
        const aborter = new AbortController()
        const socket = await bunSocketDial.connect("127.0.0.1", address.port, { signal: aborter.signal })
        const writer = socket.writable.getWriter()
        const writing = writer.write(new Uint8Array([1]))
        await started
        if (termination === "close") await socket.close()
        else aborter.abort()
        const message = termination === "close" ? "socket closed" : "aborted"
        await expect(writing).rejects.toThrow(message)
        lateCallback?.()
        await expect(writing).rejects.toThrow(message)
        writer.releaseLock()
        await socket.close()
      } finally {
        net.Socket.prototype.write = originalWrite
        accepted?.destroy()
        await new Promise<void>(resolve => server.close(() => resolve()))
      }
    }, 2000)
  }

  it("preserves the socket write callback error", async () => {
    let accepted: net.Socket | undefined
    const server = net.createServer(socket => { accepted = socket })
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("missing port")

    const originalWrite = net.Socket.prototype.write
    const writeError = new Error("write callback failed")
    net.Socket.prototype.write = function (...args: unknown[]): boolean {
      if (this.remotePort === address.port) {
        const index = args.findIndex(value => typeof value === "function")
        if (index < 0) throw new Error("expected a socket write callback")
        const callback = args[index] as (error?: Error) => void
        args[index] = () => callback(writeError)
      }
      return originalWrite.apply(this, args as Parameters<typeof originalWrite>)
    }

    try {
      const socket = await bunSocketDial.connect("127.0.0.1", address.port)
      const writer = socket.writable.getWriter()
      await expect(writer.write(new Uint8Array([1]))).rejects.toBe(writeError)
      writer.releaseLock()
      await socket.close()
    } finally {
      net.Socket.prototype.write = originalWrite
      accepted?.destroy()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  }, 2000)

  for (const status of [200, 413]) {
    it(`finishes an early ${status} response with a bounded pending upload`, async () => {
      let accepted: net.Socket | undefined
      const server = net.createServer(socket => {
        accepted = socket
        let head = ""
        socket.on("data", data => {
          head += data.toString()
          if (!head.includes("\r\n\r\n")) return
          socket.removeAllListeners("data")
          socket.pause()
          socket.write(`HTTP/1.1 ${status} Early\r\nContent-Length: 10\r\nConnection: close\r\n\r\nearly-`)
          setTimeout(() => socket.write("tail"), 10)
        })
      })
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("missing port")

      try {
        const socket = await bunSocketDial.connect("127.0.0.1", address.port)
        let cancelled = 0
        const body: ReplayableBody = {
          kind: "replayable",
          contentLength: 100_000_000,
          open() {
            return new ReadableStream<Uint8Array>({
              pull(controller) { controller.enqueue(new Uint8Array(65536)) },
              cancel() { cancelled++ },
            }, { highWaterMark: 0 })
          },
        }
        const response = await fetchOnStream(
          socket,
          { method: "POST", path: "/", headers: { Host: "localhost" }, body },
          undefined,
          { closeTransport: () => socket.close() },
        )
        expect(response.status).toBe(status)
        expect(await response.text()).toBe("early-tail")
        expect(cancelled).toBe(1)
        expect(socket.writable.locked).toBe(false)
      } finally {
        accepted?.destroy()
        await new Promise<void>(resolve => server.close(() => resolve()))
      }
    }, 2000)
  }
})
