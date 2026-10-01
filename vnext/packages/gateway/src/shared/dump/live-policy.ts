import { ChannelCapacityError, encodedFrameCharge, type ChannelQueuePolicy } from "../runtime/channel-broker-contract.ts"
import type { DumpMetadata } from "./types.ts"

export const DUMP_LIVE_LIMIT = 100
export const DUMP_LIVE_QUEUE_POLICY: ChannelQueuePolicy = {
  maxFrames: 100, maxQueueBytes: 256 * 1024, maxFrameBytes: 16 * 1024,
}

// SQL materialization and encoding transients are outside this retention charge.
export function selectLatestDumpSnapshot(records: DumpMetadata[], policy = DUMP_LIVE_QUEUE_POLICY) {
  const admitted: DumpMetadata[] = []
  const hasMore = records.length >= DUMP_LIVE_LIMIT
  const cursor = records.at(-1)?.id
  const envelope = { records: admitted, view: "latest" as const, limit: DUMP_LIVE_LIMIT,
    omittedRows: records.length, completeHistory: false as const, hasMore }
  const before = cursor === undefined ? {} : { before: cursor }
  // Reserve the envelope and cursor too, including the largest omission count.
  // Production IDs are ULIDs; an oversized envelope requires reconciliation.
  let bytes = encodedFrameCharge(JSON.stringify({ ...envelope, ...before }))
  if (bytes > policy.maxQueueBytes) {
    throw new ChannelCapacityError("queue_bytes")
  }
  let omittedRows = 0
  for (const record of records) {
    const charge = encodedFrameCharge(JSON.stringify(record))
    if (admitted.length >= DUMP_LIVE_LIMIT || charge > policy.maxFrameBytes || charge > policy.maxQueueBytes - bytes) {
      omittedRows++
      continue
    }
    // Per-row bookkeeping charge also conservatively covers JSON separators.
    bytes += charge
    admitted.push(record)
  }
  return { ...envelope, ...before, omittedRows }
}
