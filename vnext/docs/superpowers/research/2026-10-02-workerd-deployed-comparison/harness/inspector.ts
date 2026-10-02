import { deadline } from "./supervisor.ts"

type Obj = Record<string, unknown>
export interface Target { title?: string; id?: string; webSocketDebuggerUrl?: string }
export function selectTarget(targets: Target[], name: string): Target {
  const matched = targets.filter(target => {
    if (!target.webSocketDebuggerUrl) return false
    try { return new URL(target.webSocketDebuggerUrl).pathname === `/${encodeURIComponent(name)}` } catch { return false }
  })
  const target = matched[0]
  if (matched.length !== 1 || !target?.webSocketDebuggerUrl) throw new Error(`Inspector requires exactly one exact target ${name}`)
  const url = new URL(target.webSocketDebuggerUrl)
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.protocol !== "ws:") throw new Error("Inspector target must be local")
  return target
}
export interface Inspector { send(method: string, params?: Obj): Promise<unknown>; close(): Promise<void> }
export async function attach(getURL: () => Promise<URL>, name: string): Promise<Inspector> {
  const inspectorURL = await deadline("inspector URL", 10000, getURL)
  const targets = await deadline("inspector discovery", 10000, async () => {
    const discovery = new URL("/json/list", inspectorURL)
    discovery.protocol = "http:"
    const response = await fetch(discovery, { signal: AbortSignal.timeout(10000) })
    if (!response.ok) throw new Error("Inspector discovery HTTP failure")
    const value: unknown = await response.json()
    if (!Array.isArray(value)) throw new Error("Invalid inspector targets")
    return value as Target[]
  })
  const target = selectTarget(targets, name)
  if (!target.webSocketDebuggerUrl) throw new Error("Missing inspector socket")
  if (new URL(target.webSocketDebuggerUrl).host !== inspectorURL.host) throw new Error("Inspector target escaped the exact inspector host/port")
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  const waiting = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>()
  const rejectAll = (error: Error) => { for (const task of waiting.values()) { clearTimeout(task.timer); task.reject(error) }; waiting.clear() }
  try {
    await deadline("inspector open", 10000, () => new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve()
      socket.onerror = () => reject(new Error("Inspector connection failed"))
      socket.onclose = () => reject(new Error("Inspector closed during open"))
    }))
  } catch (error) { socket.close(); throw error }
  socket.onclose = () => rejectAll(new Error("Inspector closed"))
  socket.onerror = () => rejectAll(new Error("Inspector connection failed"))
  socket.onmessage = event => {
    try {
      const message = JSON.parse(String(event.data)) as { id?: number; error?: unknown; result?: unknown }
      if (message.id === undefined) return
      const task = waiting.get(message.id)
      if (!task) return
      clearTimeout(task.timer); waiting.delete(message.id)
      if (message.error) task.reject(new Error(`Inspector: ${JSON.stringify(message.error)}`))
      else task.resolve(message.result)
    } catch { rejectAll(new Error("Invalid inspector reply")) }
  }
  let nextId = 0
  return {
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++nextId
        const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`Inspector ${method} timed out`)) }, 10000)
        waiting.set(id, { resolve, reject, timer })
        try { socket.send(JSON.stringify({ id, method, params })) } catch (error) {
          clearTimeout(timer); waiting.delete(id); reject(error)
        }
      })
    },
    async close() {
      rejectAll(new Error("Inspector closed"))
      if (socket.readyState === WebSocket.CLOSED) return
      await deadline("inspector close", 2000, () => new Promise<void>(resolve => { socket.onclose = () => resolve(); socket.close() }))
    },
  }
}
