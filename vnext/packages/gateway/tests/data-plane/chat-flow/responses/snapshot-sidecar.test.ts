/**
 * Unit tests for packages/gateway/src/data-plane/chat-flow/responses/snapshot-sidecar.ts
 *
 * Both sidecar functions call getResponsesStore() internally — tests must
 * initialize the store via initResponsesStore() with an in-memory store.
 * Per project memory `bun_mock_module_unrestorable`, we avoid mock.module()
 * and instead instantiate a real InMemoryResponsesSnapshotStore.
 */
import { test, expect, afterEach } from 'bun:test'
import type { Context } from 'hono'
import { InMemoryResponsesSnapshotStore } from '@vnext/responses-store'
import { initResponsesStore } from '../../../../src/shared/runtime/responses-store.ts'
import { __resetPlatformForTests } from '@vnext/platform'
import {
  attachStreamSidecar,
  attachNonStreamSidecar,
} from '../../../../src/data-plane/chat-flow/responses/snapshot-sidecar.ts'

afterEach(() => { __resetPlatformForTests() })

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal Hono Context whose executionCtx.waitUntil pushes the
 * tracked promise into a shared array so tests can await all sidecar work.
 */
function fakeCtxWithWaitUntil(): { c: Context; pending: Promise<unknown>[] } {
  const pending: Promise<unknown>[] = []
  const c = {
    executionCtx: {
      waitUntil(p: Promise<unknown>) { pending.push(p) },
    },
  } as unknown as Context
  return { c, pending }
}

/** Build a Hono Context with NO executionCtx — exercises the fallback path. */
function fakeCtxNoExecution(): Context {
  return {} as unknown as Context
}

/** Build an SSE Response that emits the canonical 3-event sequence. */
function buildSSEResponse(responseId: string, model: string): Response {
  const frames = [
    `event: response.created\ndata: ${JSON.stringify({
      type: 'response.created',
      response: { id: responseId, model },
    })}\n\n`,
    `event: response.output_item.done\ndata: ${JSON.stringify({
      type: 'response.output_item.done',
      item: {
        type: 'message',
        content: [{ type: 'output_text', text: 'hi' }],
      },
    })}\n\n`,
    `event: response.completed\ndata: ${JSON.stringify({
      type: 'response.completed',
      response: { id: responseId, model },
    })}\n\n`,
  ]
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder()
      for (const frame of frames) controller.enqueue(enc.encode(frame))
      controller.close()
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('attachStreamSidecar — tees SSE and persists snapshot via responses-store', async () => {
  const store = new InMemoryResponsesSnapshotStore()
  initResponsesStore(store)

  const responseId = 'resp_stream_1'
  const response = buildSSEResponse(responseId, 'gpt-test')
  const inputItems = [{ role: 'user', content: 'q' }]
  const { c, pending } = fakeCtxWithWaitUntil()

  const returned = attachStreamSidecar({
    c,
    response,
    fallbackModel: 'gpt-test',
    apiKeyId: 'kid_1',
    requestId: 'req_1',
    mergedInputItems: inputItems,
  })

  // Drain the client-half of the tee fully so the sidecar half can also
  // complete — Bun's tee buffers per-branch and the parser only sees data
  // once the producer pushes through.
  expect(returned.body).not.toBeNull()
  const drained = await new Response(returned.body).text()
  expect(drained).toContain('response.created')
  expect(drained).toContain('response.completed')

  await Promise.all(pending)

  const snap = await store.load(responseId, 'kid_1')
  expect(snap).not.toBeNull()
  expect(snap!.model).toBe('gpt-test')
  expect(snap!.apiKeyId).toBe('kid_1')
  // Snapshot stores merged input + output (1 input message + 1 output item)
  expect(snap!.items.length).toBe(2)
  expect(snap!.items[0]).toEqual({ role: 'user', content: 'q' })
  expect(snap!.items[1]).toEqual({
    type: 'message',
    content: [{ type: 'output_text', text: 'hi' }],
  })
})

test('attachNonStreamSidecar — clones JSON and persists snapshot', async () => {
  const store = new InMemoryResponsesSnapshotStore()
  initResponsesStore(store)

  const payload = {
    id: 'resp_json_1',
    model: 'gpt-test',
    output: [{ type: 'message' }],
  }
  const response = new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
  const inputItems = [{ role: 'user', content: 'q2' }]
  const { c, pending } = fakeCtxWithWaitUntil()

  const returned = attachNonStreamSidecar({
    c,
    response,
    fallbackModel: 'gpt-test',
    apiKeyId: 'kid_2',
    requestId: 'req_2',
    mergedInputItems: inputItems,
  })

  // The sidecar uses response.clone() internally, so the original body must
  // still be readable by the caller.
  const body = await returned.json() as typeof payload
  expect(body.id).toBe('resp_json_1')
  expect(body.model).toBe('gpt-test')
  expect(body.output).toEqual([{ type: 'message' }])

  await Promise.all(pending)

  const snap = await store.load('resp_json_1', 'kid_2')
  expect(snap).not.toBeNull()
  expect(snap!.model).toBe('gpt-test')
  expect(snap!.apiKeyId).toBe('kid_2')
  expect(snap!.items.length).toBe(2)
  expect(snap!.items[0]).toEqual({ role: 'user', content: 'q2' })
  expect(snap!.items[1]).toEqual({ type: 'message' })
})

test('attachStreamSidecar — falls back to fire-and-forget when executionCtx is absent', async () => {
  const store = new InMemoryResponsesSnapshotStore()
  initResponsesStore(store)

  const responseId = 'resp_stream_no_ctx'
  const response = buildSSEResponse(responseId, 'gpt-test')
  const c = fakeCtxNoExecution()

  // Must not throw even without executionCtx.
  const returned = attachStreamSidecar({
    c,
    response,
    fallbackModel: 'gpt-test',
    apiKeyId: 'kid_3',
    requestId: 'req_3',
    mergedInputItems: [{ role: 'user', content: 'q3' }],
  })

  expect(returned.body).not.toBeNull()
  await new Response(returned.body).text()

  // No waitUntil to await — poll briefly so the fire-and-forget save lands.
  for (let i = 0; i < 50; i++) {
    const snap = await store.load(responseId, 'kid_3')
    if (snap) break
    await new Promise((r) => setTimeout(r, 5))
  }

  const snap = await store.load(responseId, 'kid_3')
  expect(snap).not.toBeNull()
  expect(snap!.items.length).toBe(2)
})
