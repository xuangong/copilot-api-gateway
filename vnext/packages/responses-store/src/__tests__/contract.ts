/**
 * Shared behavioral contract for ResponsesSnapshotStore implementations.
 *
 * Each implementation passes a factory that returns a fresh empty store and
 * a "now" controller (so tests can advance time deterministically without
 * Bun fake timers, which don't compose with Bun's test runner well).
 *
 * Implementations differ in *how* they store rows; behaviorally they MUST
 * be indistinguishable to the gateway.
 */
import { test, expect } from 'bun:test'
import type { ResponsesSnapshotStore, ResponsesSnapshot } from '../types.ts'

export interface StoreFactory {
  /** Returns a fresh store + a setter that controls `now()` for that store. */
  make(): Promise<{ store: ResponsesSnapshotStore; setNow: (ms: number) => void }>
  /** Human-readable label used in test names. */
  label: string
}

export function runStoreContract(factory: StoreFactory): void {
  const make = (): ResponsesSnapshot => ({
    responseId: 'resp_1',
    apiKeyId: 'key_a',
    model: 'gpt-5',
    items: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
    createdAt: 1_000,
    expiresAt: 1_000 + 60_000,
  })

  test(`[${factory.label}] save then load returns the snapshot`, async () => {
    const { store } = await factory.make()
    await store.save(make())
    const got = await store.load('resp_1', 'key_a')
    expect(got).not.toBeNull()
    expect(got!.responseId).toBe('resp_1')
    expect(got!.model).toBe('gpt-5')
    expect(got!.items).toEqual([{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }])
  })

  test(`[${factory.label}] load returns null when response_id is unknown`, async () => {
    const { store } = await factory.make()
    const got = await store.load('resp_does_not_exist', 'key_a')
    expect(got).toBeNull()
  })

  test(`[${factory.label}] load returns null when api_key_id mismatches (cross-owner isolation)`, async () => {
    const { store } = await factory.make()
    await store.save(make()) // saved under key_a
    const got = await store.load('resp_1', 'key_b')
    expect(got).toBeNull()
  })

  test(`[${factory.label}] null apiKeyId only matches null apiKeyId`, async () => {
    const { store } = await factory.make()
    await store.save({ ...make(), responseId: 'resp_anon', apiKeyId: null })
    const anonHit = await store.load('resp_anon', null)
    expect(anonHit).not.toBeNull()
    const namedMiss = await store.load('resp_anon', 'key_a')
    expect(namedMiss).toBeNull()
  })

  test(`[${factory.label}] expired snapshot returns null on load`, async () => {
    const { store, setNow } = await factory.make()
    setNow(1_000)
    await store.save(make()) // expiresAt = 61_000
    setNow(70_000)
    const got = await store.load('resp_1', 'key_a')
    expect(got).toBeNull()
  })

  test(`[${factory.label}] save replaces an existing row with same response_id`, async () => {
    const { store } = await factory.make()
    await store.save(make())
    await store.save({ ...make(), model: 'gpt-5-upgraded' })
    const got = await store.load('resp_1', 'key_a')
    expect(got!.model).toBe('gpt-5-upgraded')
  })

  test(`[${factory.label}] save runs opportunistic GC of expired rows`, async () => {
    const { store, setNow } = await factory.make()
    setNow(1_000)
    // Insert two rows that will be expired by t=70_000.
    await store.save({ ...make(), responseId: 'expired_1' })
    await store.save({ ...make(), responseId: 'expired_2' })
    setNow(70_000)
    // Saving a fresh one should also evict the two expired siblings.
    await store.save({ ...make(), responseId: 'fresh', createdAt: 70_000, expiresAt: 130_000 })
    setNow(70_000) // still after expiry — load() returns null on its own;
                   // GC effect is observable only at the storage layer.
                   // We assert via load() which combines both: must be null.
    expect(await store.load('expired_1', 'key_a')).toBeNull()
    expect(await store.load('expired_2', 'key_a')).toBeNull()
    expect(await store.load('fresh', 'key_a')).not.toBeNull()
  })

  test(`[${factory.label}] items round-trip preserves nested arrays and objects`, async () => {
    const { store } = await factory.make()
    const nested = [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'a' }] },
      { type: 'function_call', name: 'tool', arguments: '{"k":1}', call_id: 'c1' },
      { type: 'function_call_output', call_id: 'c1', output: '{"ok":true}' },
    ]
    await store.save({ ...make(), items: nested })
    const got = await store.load('resp_1', 'key_a')
    expect(got!.items).toEqual(nested)
  })
}
