import { Database } from 'bun:sqlite'
import { afterEach, expect, test } from 'bun:test'
import { eventFrame, type ProtocolFrame } from '@vibe-core/result'
import { llmEventResult, type TelemetryModelIdentity } from '@vibe-llm/protocols/common'
import type { ResponsesStreamEvent } from '@vibe-llm/protocols/responses'
import { BunSqliteDatabase } from '@vibe-llm/platform-bun/src/bun-sqlite-database.ts'
import { BunSqliteRepo } from '@vibe-llm/platform-bun/src/bun-sqlite-repo.ts'
import { createBunResponsesStore } from '@vibe-llm/platform-bun/src/responses-store-factory.ts'
import { createResponseSnapshotWriter } from '../../../../src/data-plane/chat-flow/responses/completion-snapshot.ts'
import { respondResponses } from '../../../../src/data-plane/chat-flow/responses/respond.ts'
import { expandPreviousResponseId } from '../../../../src/data-plane/dispatch/responses-store-bridge.ts'

const identity: TelemetryModelIdentity = {
  incomingModel: 'test-model', model: 'test-model', upstream: 'test', modelKey: 'test-model', cost: null,
}

const databases: Database[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})

function sqliteStore() {
  const db = new Database(':memory:')
  databases.push(db)
  new BunSqliteRepo(db)
  return createBunResponsesStore(new BunSqliteDatabase(db))
}

function completedFrames(): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {
  const neighbor = { id: 'msg_neighbor', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'retained' }] }
  const first = { id: 'cmp_first', type: 'compaction', encrypted_content: 'native-one' }
  const second = { id: 'cmp_second', type: 'compaction_summary', encrypted_content: 'native-two' }
  const tail = { id: 'msg_tail', type: 'message', role: 'user', content: [{ type: 'input_text', text: 'tail' }] }
  return (async function* () {
    yield eventFrame({ type: 'response.output_item.done', output_index: 1, item: first } as ResponsesStreamEvent)
    yield eventFrame({ type: 'response.output_item.done', output_index: 0, item: neighbor } as ResponsesStreamEvent)
    yield eventFrame({ type: 'response.output_item.done', output_index: 2, item: second } as ResponsesStreamEvent)
    yield eventFrame({ type: 'response.completed', response: {
      id: 'resp_compacted', object: 'response', model: 'test-model', status: 'completed',
      output: [second, tail], error: null, incomplete_details: null,
    } } as ResponsesStreamEvent)
  })()
}

for (const wantsStream of [false, true]) {
  test(`completed ${wantsStream ? 'SSE' : 'JSON'} compact window survives immediate SQLite continuation`, async () => {
    const store = sqliteStore()
    const inputItems = [
      { type: 'message', role: 'user', content: 'old history' },
      { type: 'compaction_trigger' },
    ]
    const response = await respondResponses(llmEventResult(completedFrames(), identity), {
      wantsStream,
      mergedInputItems: inputItems,
      onCompleted: createResponseSnapshotWriter({ store, apiKeyId: 'key', retentionSeconds: 86400, fallbackModel: 'test-model', compactTriggered: true }),
    })
    await response.text()
    const stored = await store.load('resp_compacted', 'key')
    expect(stored?.items).toEqual([
      { id: 'msg_neighbor', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'retained' }] },
      { id: 'cmp_first', type: 'compaction', encrypted_content: 'native-one' },
      { id: 'cmp_second', type: 'compaction_summary', encrypted_content: 'native-two' },
      { id: 'msg_tail', type: 'message', role: 'user', content: [{ type: 'input_text', text: 'tail' }] },
    ])
    const continuation = { previous_response_id: 'resp_compacted', input: [{ type: 'message', role: 'user', content: 'next turn' }] }
    await expandPreviousResponseId(continuation, store, 'key')
    expect(continuation.input).toEqual([...(stored?.items ?? []), { type: 'message', role: 'user', content: 'next turn' }])
  })
}

for (const status of ['failed', 'incomplete'] as const) {
  test(`${status} compact output cannot replace a completed SQLite snapshot`, async () => {
    const store = sqliteStore()
    await store.save({ responseId: 'resp_prior', apiKeyId: 'key', model: 'test-model',
      items: [{ type: 'message', role: 'user', content: 'prior' }],
      createdAt: Date.now(), expiresAt: Date.now() + 60_000 })
    async function* frames(): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {
      yield eventFrame({ type: `response.${status}`, response: {
        id: 'resp_partial', object: 'response', model: 'test-model', status,
        output: [{ id: 'cmp_partial', type: 'compaction', encrypted_content: 'partial' }],
        error: status === 'failed' ? { code: 'server_error', message: 'failure' } : null,
        incomplete_details: status === 'incomplete' ? { reason: 'max_output_tokens' } : null,
      } } as ResponsesStreamEvent)
    }
    const response = await respondResponses(llmEventResult(frames(), identity), {
      wantsStream: false,
      mergedInputItems: [{ type: 'compaction_trigger' }],
      onCompleted: createResponseSnapshotWriter({ store, apiKeyId: 'key', retentionSeconds: 86400, fallbackModel: 'test-model', compactTriggered: true }),
    })
    expect((await response.json() as { status: string }).status).toBe(status)
    expect(await store.load('resp_partial', 'key')).toBeNull()
    expect((await store.load('resp_prior', 'key'))?.items).toEqual([{ type: 'message', role: 'user', content: 'prior' }])
  })
}
