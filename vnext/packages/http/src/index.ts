// Legacy helpers used by existing providers.
export * from './fetch-retry'
export * from './headers'
export * from './body'

// New protocol-layer surface (ported from reference @floway-dev/http):
// HTTP/1.1 over duplex, userspace TLS, WebSocket framing.

export type { DuplexStream, HttpRequest, RawHttpResponse } from './types.ts'

export { fetchOnStream } from './fetch-on-stream.ts'
export { parseHttpResponse, toWebResponse } from './parser.ts'
export { decodeChunked } from './chunked.ts'

export { userspaceTls, addTrustedRootCAs } from './tls.ts'
export type { UserspaceTlsOptions, TlsStream } from './tls.ts'

export { wsUpgradeAndFrame } from './ws-upgrade.ts'
export type { WsUpgradeOptions } from './ws-upgrade.ts'

export { signalAbortReason, isAbortError } from './abort.ts'

export { HttpProtocolError } from './errors.ts'
export type { HttpProtocolErrorCode } from './errors.ts'

export { STATUS_LINE } from './grammar.ts'
