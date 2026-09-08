import { api } from "./client"
import type { PerformanceMetricsResponse } from "@vibe-llm/protocols/common"

export function listPerformanceMetrics(start: string, end: string): Promise<PerformanceMetricsResponse> {
  return api<PerformanceMetricsResponse>("/api/performance/metrics", { query: { start, end } })
}
