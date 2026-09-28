import { normalizeDialHost, throwAbort, type DialedSocket, type SocketDial } from "@vibe-core/platform"

export interface CloudflareSocketLike {
  readonly readable: ReadableStream<Uint8Array>
  readonly writable: WritableStream<Uint8Array>
  readonly opened: Promise<void>
  readonly closed: Promise<void>
  close(): Promise<void>
}

type Connect = (
  address: { hostname: string; port: number },
  options: { allowHalfOpen: boolean; secureTransport: "on" | "off" },
) => CloudflareSocketLike

const WORKERD_CONNECT_ERROR = "proxy request failed, cannot connect to the specified address"

// Injecting connect keeps the classification test independent of the workerd-only
// cloudflare:sockets module. Each dial instance owns its own private marks.
export const createCloudflareSocketDial = (connect: Connect): SocketDial => {
  const fallbackErrors = new WeakSet<object>()
  return {
    shouldConnectErrorFallbackToFetch: error =>
      typeof error === "object" && error !== null && fallbackErrors.has(error),

    async connect(host, port, opts): Promise<DialedSocket> {
      if (opts?.signal?.aborted) throwAbort(opts.signal)
      const socket = connect(
        { hostname: normalizeDialHost(host), port },
        { allowHalfOpen: !opts?.tls, secureTransport: opts?.tls ? "on" : "off" },
      )
      const safeClose = async (): Promise<void> => {
        try { await socket.close() } catch { /* already closed/errored */ }
      }
      let abortListener: (() => void) | null = null
      const removeAbortListener = (): void => {
        if (abortListener && opts?.signal) {
          opts.signal.removeEventListener("abort", abortListener)
          abortListener = null
        }
      }
      if (opts?.signal) {
        abortListener = (): void => { void safeClose() }
        opts.signal.addEventListener("abort", abortListener, { once: true })
      }
      void socket.closed.catch(() => {}).finally(removeAbortListener)

      try {
        await socket.opened
      } catch (cause) {
        removeAbortListener()
        await safeClose()
        if (opts?.signal?.aborted) throwAbort(opts.signal)
        const error = new Error(`dial ${host}:${port} failed`, { cause })
        if (cause instanceof Error && cause.message.startsWith(WORKERD_CONNECT_ERROR)) {
          fallbackErrors.add(error)
        }
        throw error
      }

      if (opts?.signal?.aborted) {
        await safeClose()
        throwAbort(opts.signal)
      }
      return {
        readable: socket.readable,
        writable: socket.writable,
        close: async () => {
          removeAbortListener()
          await safeClose()
        },
      }
    },
  }
}
