import type { TelemetrySeries } from "../../api/telemetry"
import { latencyCheckMetric, maskUnpassed } from "./telemetry-format"

type SeriesFetcher = (id: string, query: { metric: string; from: string; to: string; groupBy?: string; top?: number }) => Promise<TelemetrySeries>

/** The series to draw. A latency metric is fetched together with its check metric and keeps a value only in hours whose check passed. */
export async function loadSeries(
  fetchSeries: SeriesFetcher,
  sourceId: string,
  query: { metric: string; from: string; to: string; groupBy: string; checkMetrics: readonly string[] },
): Promise<TelemetrySeries> {
  const span = { from: query.from, to: query.to }
  const check = latencyCheckMetric(query.metric, query.checkMetrics)
  const [series, checkSeries] = await Promise.all([
    fetchSeries(sourceId, { metric: query.metric, ...span, groupBy: query.groupBy || undefined, top: 10 }),
    check ? fetchSeries(sourceId, { metric: check, ...span }) : Promise.resolve(null),
  ])
  return checkSeries ? maskUnpassed(series, { hours: checkSeries.hours, statuses: checkSeries.statuses ?? [] }) : series
}
