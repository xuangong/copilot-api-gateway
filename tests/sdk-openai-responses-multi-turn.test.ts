// tests/sdk-openai-responses-multi-turn.test.ts
/**
 * Adapted from openai-node's responses examples — the official SDK shape is
 * `client.responses.create({ model, input, previous_response_id })`. We run
 * the same shape against the gateway to prove `previous_response_id`
 * expansion works end-to-end via the snapshot store.
 *
 * Pre-req: `bun run local` is up at TEST_API_BASE_URL.
 */
import { test, expect } from 'bun:test'
import OpenAI from 'openai'

const baseURL = process.env.TEST_API_BASE_URL ?? 'http://localhost:8787/v1'

const client = new OpenAI({ apiKey: 'test-key', baseURL })

test('responses previous_response_id round-trip on a chat-backed model', async () => {
  const turn1 = await client.responses.create({
    model: 'gpt-4o-mini',
    input: [{ role: 'user', content: 'My favorite color is azure. Remember it.' }],
  })
  expect(turn1.id).toMatch(/^resp/)

  const turn2 = await client.responses.create({
    model: 'gpt-4o-mini',
    previous_response_id: turn1.id,
    input: [{ role: 'user', content: 'What is my favorite color?' }],
  })
  const text = JSON.stringify(turn2.output ?? [])
  expect(text.toLowerCase()).toContain('azure')
}, 60_000)

test('responses previous_response_id round-trip on a responses-backed model', async () => {
  // Run if the deployment exposes a responses-native model id; skip otherwise.
  const modelId = process.env.TEST_RESPONSES_MODEL_ID
  if (!modelId) return
  const turn1 = await client.responses.create({
    model: modelId,
    input: [{ role: 'user', content: 'My lucky number is 73. Remember it.' }],
  })
  expect(turn1.id).toMatch(/^resp/)

  const turn2 = await client.responses.create({
    model: modelId,
    previous_response_id: turn1.id,
    input: [{ role: 'user', content: 'What is my lucky number?' }],
  })
  const text = JSON.stringify(turn2.output ?? [])
  expect(text).toContain('73')
}, 60_000)

test('unknown previous_response_id surfaces 400 previous_response_not_found', async () => {
  await expect(
    client.responses.create({
      model: 'gpt-4o-mini',
      previous_response_id: 'resp_definitely_not_real',
      input: [{ role: 'user', content: 'hi' }],
    }),
  ).rejects.toMatchObject({ status: 400 })
}, 30_000)
