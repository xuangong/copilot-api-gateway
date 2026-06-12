import { runStoreContract } from './contract.ts'
import { InMemoryResponsesSnapshotStore } from '../in-memory.ts'

runStoreContract({
  label: 'in-memory',
  async make() {
    let nowMs = 0
    const store = new InMemoryResponsesSnapshotStore({ now: () => nowMs })
    return {
      store,
      setNow: (ms) => { nowMs = ms },
      rawCount: async () => store._size(),
      // injectCorruptRow intentionally omitted: in-memory storage holds typed
      // values, so the corrupt-JSON case is structurally unreachable here.
    }
  },
})
