// Cloudflare Workers SocketDial impl. Ported from copilot-gateway.
//
// cloudflare:sockets doesn't accept a signal on connect itself, so we honour
// it ourselves. A pre-aborted signal short-circuits; once opened, an abort
// closes the socket so subsequent reads/writes reject. The listener is
// detached on close() and on natural socket close.
//
// We `await socket.opened` before resolving so a TLS handshake error or
// connect-refused surfaces as a connect-time rejection (with `cause`)
// rather than as an opaque first-read failure later.

import { connect } from "cloudflare:sockets"

import {
  normalizeDialHost,
  throwAbort,
  type DialedSocket,
  type SocketDial,
} from "@vibe-core/platform"

export const cloudflareSocketDial: SocketDial = {
  async connect(host, port, opts): Promise<DialedSocket> {
    if (opts?.signal?.aborted) throwAbort(opts.signal)
    const dialHost = normalizeDialHost(host)
    const socket = connect(
      { hostname: dialHost, port },
      {
        // Half-open honoured for plain TCP only. TLS 1.3 close-notify is fragile
        // across implementations — write-side close on TLS tears down the whole
        // socket, mirroring Node's deliberate no-half-open-on-TLS.
        allowHalfOpen: !opts?.tls,
        secureTransport: opts?.tls ? "on" : "off",
      },
    )
    // Idempotent close — the runtime can reject `socket.close()` on an errored
    // socket, and a stalled close promise must not block teardown.
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
      const signal = opts.signal
      abortListener = (): void => { void safeClose() }
      signal.addEventListener("abort", abortListener, { once: true })
    }
    void socket.closed.catch(() => { /* errors observed via opened/streams */ }).finally(removeAbortListener)

    try {
      await socket.opened
    } catch (cause) {
      removeAbortListener()
      await safeClose()
      if (opts?.signal?.aborted) throwAbort(opts.signal)
      throw new Error(`dial ${host}:${port} failed`, { cause })
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
