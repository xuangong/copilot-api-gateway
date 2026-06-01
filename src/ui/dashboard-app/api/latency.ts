import { api } from "./client"

export interface LatencyRecord {
  keyId: string
  model: string
  hour: string
  colo: string
  stream: boolean
  requests: number
  totalMs: number
  upstreamMs: number
  ttfbMs: number
  tokenMiss: number
  keyName?: string
}

export function listLatency(start: string, end: string): Promise<LatencyRecord[]> {
  return api<LatencyRecord[]>("/api/latency", { query: { start, end } })
}
