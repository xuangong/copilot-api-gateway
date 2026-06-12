import { runStoreContract } from './contract.ts'
import { InMemoryResponsesSnapshotStore } from '../in-memory.ts'

runStoreContract({
  label: 'in-memory',
  async make() {
    let nowMs = 0
    const store = new InMemoryResponsesSnapshotStore({ now: () => nowMs })
    return { store, setNow: (ms) => { nowMs = ms } }
  },
})
