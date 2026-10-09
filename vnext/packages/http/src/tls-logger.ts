import type { makeTLSClient } from "@reclaimprotocol/tls"

type TlsLogger = NonNullable<Parameters<typeof makeTLSClient>[0]["logger"]>
type Level = "debug" | "info" | "warn" | "error"

const emit = (level: Level, args: unknown[]): void => {
  const fields = typeof args[0] === "object" && args[0] !== null
    ? args[0] as Record<string, unknown>
    : undefined
  // The pinned dependency supplies static event messages, but its detail
  // objects can include plaintext packets, certificates and key material.
  // Only TLS alert enums cross this logging boundary, even in debug mode.
  const message = typeof args[0] === "string" ? args[0]
    : typeof args[1] === "string" ? args[1] : "TLS diagnostic"
  console[level](JSON.stringify({
    component: "userspace-tls",
    level,
    message,
    ...(typeof fields?.level === "string" ? { alert_level: fields.level } : {}),
    ...(typeof fields?.description === "string" ? { alert: fields.description } : {}),
  }))
}

const noop = (): void => {}
const debugLogger: TlsLogger = {
  // Packet trace is intentionally disabled, including during diagnosis.
  trace: noop,
  debug: (...args: unknown[]) => emit("debug", args),
  info: (...args: unknown[]) => emit("info", args),
  warn: (...args: unknown[]) => emit("warn", args),
  error: (...args: unknown[]) => emit("error", args),
}
const normalLogger: TlsLogger = {
  ...debugLogger,
  debug: noop,
  info: noop,
  warn: (...args: unknown[]) => {
    const fields = args[0]
    // Reclaim reports graceful peer shutdown at warning level.
    if (typeof fields === "object" && fields !== null
      && "description" in fields && fields.description === "CLOSE_NOTIFY"
      && "level" in fields && fields.level === "WARNING") return
    emit("warn", args)
  },
}

export const getTlsLogger = (): TlsLogger => {
  const proc = (globalThis as { process?: { env?: { DEBUG_USERSPACE_TLS?: string } } }).process
  const debug = proc?.env?.DEBUG_USERSPACE_TLS
  return debug === "1" || debug === "true" ? debugLogger : normalLogger
}
