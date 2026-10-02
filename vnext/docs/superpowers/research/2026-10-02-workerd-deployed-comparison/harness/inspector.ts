import { deadline } from "./supervisor.ts"

type Obj = Record<string, unknown>
export interface Target { title?: string; id?: string; webSocketDebuggerUrl?: string }
export function selectTarget(targets: Target[], name: string, inspectorURL: URL): Target {
  const id = `core:user:${name}`
  const observed = targets.map(target => ({ id: target.id, title: target.title, webSocketDebuggerUrl: target.webSocketDebuggerUrl }))
  const mismatch = (reason: string) => new Error(`Inspector requires exactly one exact raw target ${id} at ${inspectorURL.host}: ${reason}; observed=${JSON.stringify(observed)}`)
  if (inspectorURL.protocol !== "ws:" || !["127.0.0.1", "localhost", "[::1]"].includes(inspectorURL.hostname)) throw mismatch("discovery must be local ws")
  const matched = targets.filter(target => target.id === id)
  const target = matched[0]
  if (matched.length !== 1 || !target?.webSocketDebuggerUrl) throw mismatch("missing or ambiguous identity")
  let url: URL
  try { url = new URL(target.webSocketDebuggerUrl) } catch { throw mismatch("invalid socket URL") }
  if (url.protocol !== "ws:" || url.host !== inspectorURL.host || url.pathname !== `/${id}` || url.search || url.hash || url.username || url.password) throw mismatch("socket must match exact ID/path and inspector host/port")
  return target
}
export interface Inspector { identity: { inspectorURL: string; target: Target }; send(method: string, params?: Obj): Promise<unknown>; close(): Promise<void> }
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
  const target = selectTarget(targets, name, inspectorURL)
  if (!target.webSocketDebuggerUrl) throw new Error("Missing inspector socket")
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
    identity: { inspectorURL: String(inspectorURL), target },
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
