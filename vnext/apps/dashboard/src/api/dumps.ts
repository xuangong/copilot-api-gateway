import { api, ApiError } from "./client"

export interface DumpMetadata {
  id: string
  startedAt: number
  completedAt: number
  method: string
  path: string
  status: number | null
  upstream: { id: string; name: string; kind: string } | null
  model: string | null
  inputTokens: number | null
  outputTokens: number | null
  requestBytes: number
  responseBytes: number
  durationMs: number
  error: { kind: string; reason?: string } | null
}

export interface DumpBody { encoding: "utf8" | "base64"; data: string }
export interface DumpRecord {
  meta: DumpMetadata
  request: { method: string; path: string; headers: Array<[string, string]>; body: DumpBody }
  response: {
    status: number | null
    headers: Array<[string, string]>
    body: { type: "none" } | { type: "bytes"; body: DumpBody } | { type: "stream"; events: Array<{ frame: unknown; ts: number }> }
  }
}

const base = (keyId: string) => `/api/keys/${encodeURIComponent(keyId)}`
const recordPath = (keyId: string, recordId: string) => `${base(keyId)}/records/${encodeURIComponent(recordId)}`

export const listDumpRecords = (keyId: string, before: string | undefined, signal: AbortSignal) =>
  api<{ records: DumpMetadata[] }>(`${base(keyId)}/records`, { query: { limit: 25, before }, signal })

export const getDumpRecord = (keyId: string, recordId: string, signal: AbortSignal) =>
  api<DumpRecord>(recordPath(keyId, recordId), { signal })

export const dumpStreamUrl = (keyId: string) => `${base(keyId)}/stream`

export async function downloadRedactedDump(keyId: string, recordId: string, signal: AbortSignal): Promise<void> {
  const response = await fetch(`${recordPath(keyId, recordId)}/export`, { credentials: "include", signal })
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null)
    const message = body && typeof body === "object" && "error" in body && typeof body.error === "string"
      ? body.error : `HTTP ${response.status}`
    throw new ApiError(response.status, body, message)
  }
  const blob = await response.blob()
  if (signal.aborted) return
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = `request-${recordId}.json`
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
