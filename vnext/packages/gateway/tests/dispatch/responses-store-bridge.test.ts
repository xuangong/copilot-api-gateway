import { test, expect } from 'bun:test'
import { InMemoryResponsesSnapshotStore } from '@vnext/responses-store'
import {
  PreviousResponseNotFoundError,
  expandPreviousResponseId,
  savePostTurnSnapshot,
} from '../../src/data-plane/dispatch/responses-store-bridge.ts'

test('PreviousResponseNotFoundError carries id and 400 status', () => {
  const err = new PreviousResponseNotFoundError('resp_abc')
  expect(err).toBeInstanceOf(Error)
  expect(err.responseId).toBe('resp_abc')
  expect(err.status).toBe(400)
  expect(err.message).toBe("Previous response with id 'resp_abc' not found.")
})

test('expand: no previous_response_id is a no-op', async () => {
  const store = new InMemoryResponsesSnapshotStore()
  const payload: { input?: unknown[]; previous_response_id?: string | null } = {
    input: [{ type: 'message', role: 'user', content: 'hi' }],
  }
  await expandPreviousResponseId(payload, store, 'k1')
  expect(payload.input).toEqual([{ type: 'message', role: 'user', content: 'hi' }])
  expect(payload.previous_response_id).toBeUndefined()
})

test('expand: hit prepends snapshot items and deletes the field', async () => {
  const store = new InMemoryResponsesSnapshotStore()
  await store.save({
    responseId: 'resp_1',
    apiKeyId: 'k1',
    model: 'gpt-x',
    items: [
      { type: 'message', role: 'user', content: 'turn1 user' },
      { type: 'message', role: 'assistant', content: 'turn1 assistant' },
    ],
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  })
  const payload: { input?: unknown[]; previous_response_id?: string | null } = {
    previous_response_id: 'resp_1',
    input: [{ type: 'message', role: 'user', content: 'turn2 user' }],
  }
  await expandPreviousResponseId(payload, store, 'k1')
  expect(payload.previous_response_id).toBeUndefined()
  expect(payload.input).toEqual([
    { type: 'message', role: 'user', content: 'turn1 user' },
    { type: 'message', role: 'assistant', content: 'turn1 assistant' },
    { type: 'message', role: 'user', content: 'turn2 user' },
  ])
})

test('expand: missing input is treated as empty array', async () => {
  const store = new InMemoryResponsesSnapshotStore()
  await store.save({
    responseId: 'resp_2',
    apiKeyId: null,
    model: 'gpt-x',
    items: [{ type: 'message', role: 'user', content: 'old' }],
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  })
  const payload: { input?: unknown[]; previous_response_id?: string | null } = {
    previous_response_id: 'resp_2',
  }
  await expandPreviousResponseId(payload, store, null)
  expect(payload.input).toEqual([{ type: 'message', role: 'user', content: 'old' }])
})

test('expand: unknown id throws PreviousResponseNotFoundError', async () => {
  const store = new InMemoryResponsesSnapshotStore()
  const payload = { previous_response_id: 'resp_missing' }
  await expect(expandPreviousResponseId(payload, store, 'k1'))
    .rejects.toBeInstanceOf(PreviousResponseNotFoundError)
})

test('expand: snapshot owned by another api key is not visible', async () => {
  const store = new InMemoryResponsesSnapshotStore()
  await store.save({
    responseId: 'resp_owned',
    apiKeyId: 'k_other',
    model: 'gpt-x',
    items: [{ type: 'message', role: 'user', content: 'secret' }],
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  })
  const payload = { previous_response_id: 'resp_owned' }
  await expect(expandPreviousResponseId(payload, store, 'k1'))
    .rejects.toBeInstanceOf(PreviousResponseNotFoundError)
})

test('save: writes merged input+output items keyed by responseId', async () => {
  const store = new InMemoryResponsesSnapshotStore()
  const inputItems = [{ type: 'message', role: 'user', content: 'in1' }]
  const outputItems = [{ type: 'message', role: 'assistant', content: 'out1' }]
  await savePostTurnSnapshot(store, {
    responseId: 'resp_save_1',
    apiKeyId: 'k1',
    model: 'gpt-x',
    inputItems,
    outputItems,
  })
  const got = await store.load('resp_save_1', 'k1')
  expect(got).not.toBeNull()
  expect(got!.items).toEqual([...inputItems, ...outputItems])
  expect(got!.model).toBe('gpt-x')
  expect(got!.apiKeyId).toBe('k1')
  expect(got!.expiresAt).toBeGreaterThan(got!.createdAt)
})

test('save: anonymous owner uses null apiKeyId', async () => {
  const store = new InMemoryResponsesSnapshotStore()
  await savePostTurnSnapshot(store, {
    responseId: 'resp_save_2',
    apiKeyId: null,
    model: 'gpt-x',
    inputItems: [],
    outputItems: [{ type: 'message', role: 'assistant', content: 'hi' }],
  })
  expect(await store.load('resp_save_2', null)).not.toBeNull()
  expect(await store.load('resp_save_2', 'k1')).toBeNull()
})
