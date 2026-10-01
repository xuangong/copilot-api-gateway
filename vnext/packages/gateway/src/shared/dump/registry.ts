import { DUMP_DISABLED_REASON, type DumpBroker } from "./broker.ts"
import type { DumpStore } from "./store-contract.ts"
import type { ApiKeyId } from "../../repo/branded-ids.ts"
import { DumpStreamPermits } from "./stream-permits.ts"
import type { BoundedChannelBroker } from "../runtime/channel-broker-contract.ts"
import type { DumpMetadata } from "./types.ts"
import { DumpCaptureBudget } from "./capture-budget.ts"

let _store: DumpStore | null = null
let _broker: DumpBroker | null = null
let _streamPermits = new DumpStreamPermits()
let _captureBudget = new DumpCaptureBudget()

export const getDumpStreamPermits = (): DumpStreamPermits => _streamPermits

export const getDumpLiveBroker = (): BoundedChannelBroker<DumpMetadata> => {
  const broker = getDumpBroker()
  if (!("subscribeBounded" in broker) || typeof broker.subscribeBounded !== "function") {
    throw new Error("Dump live broker requires bounded subscription support")
  }
  return broker as BoundedChannelBroker<DumpMetadata>
}

export const getDumpCaptureBudget = (): DumpCaptureBudget => _captureBudget

export const initDumpStore = (store: DumpStore): void => {
  _store = store
}

export const getDumpStore = (): DumpStore => {
  if (!_store) throw new Error("DumpStore not initialized — call initDumpStore() first")
  return _store
}

export const initDumpBroker = (broker: DumpBroker): void => {
  _broker = broker
}

export const getDumpBroker = (): DumpBroker => {
  if (!_broker) throw new Error("DumpBroker not initialized — call initDumpBroker() first")
  return _broker
}

// For tests: reset internal state so parallel test files don't leak fixtures.
export const resetDumpRegistryForTests = (): void => {
  _store = null
  _broker = null
  _captureBudget = new DumpCaptureBudget()
  _streamPermits = new DumpStreamPermits()
}

// Best-effort by contract: a broker outage must never fail the surrounding
// write, since clients reconcile on the next reconnect/refetch.
export const notifyDisabledBestEffort = async (keyId: ApiKeyId, where: string): Promise<void> => {
  try {
    await getDumpBroker().closeChannel(keyId, DUMP_DISABLED_REASON)
  } catch (err) {
    console.error(`[dump] closeChannel failed during ${where}`, keyId, err)
  }
}
