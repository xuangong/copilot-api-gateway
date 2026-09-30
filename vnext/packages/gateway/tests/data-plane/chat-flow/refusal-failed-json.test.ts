import { translatedFixture } from "./shared/translated-fixture"
import { afterEach, beforeEach, expect, test } from "bun:test"
import { __resetPlatformForTests, initBackground } from "@vibe-core/platform"
import { eventFrame, type ProtocolFrame } from '@vibe-core/result'
import { llmEventResult, type TelemetryModelIdentity } from '@vibe-llm/protocols/common'
import type { ResponsesResult, ResponsesStreamEvent } from '@vibe-llm/protocols/responses'
import { translateResponsesToChatBody } from '@vibe-llm/translate/chat-completions-via-responses'
import { translateResponsesToMessagesBody } from '@vibe-llm/translate/messages-via-responses'
import { respondChatCompletions } from '../../../src/data-plane/chat-flow/chat-completions/respond.ts'
import { respondMessages } from '../../../src/data-plane/chat-flow/messages/respond.ts'
import { respondResponses } from '../../../src/data-plane/chat-flow/responses/respond.ts'

const pending: Promise<unknown>[] = []
beforeEach(() => {
  initBackground({ waitUntil: promise => { pending.push(promise) } })
})
afterEach(async () => {
  try { while (pending.length) await Promise.all(pending.splice(0)) }
  finally { __resetPlatformForTests() }
})

const baseIdentity: TelemetryModelIdentity = {
  incomingModel: 'm', model: 'm', upstream: 'test', modelKey: 'm', cost: null,
}

async function* frames(response: ResponsesResult): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {
  yield eventFrame({ type: response.status === 'failed' ? 'response.failed' : response.status === 'incomplete' ? 'response.incomplete' : 'response.completed', response })
}

function hubResponse(status: ResponsesResult['status'], content: Array<{ type: 'output_text'; text: string } | { type: 'refusal'; refusal: string }> = []): ResponsesResult {
  return {
    id: 'r', object: 'response', model: 'm', status,
    output: content.length ? [{ type: 'message', id: 'msg_1', role: 'assistant', content }] : [],
    error: status === 'failed' ? { code: 'invalid_prompt', message: 'Policy denied' } : null,
    incomplete_details: status === 'incomplete' ? { reason: 'max_output_tokens' } : null,
  }
}

test('failed Responses JSON reaches native Responses unchanged but fails Chat and Messages responder routes', async () => {
  const failed = hubResponse('failed')
  const native = await respondResponses(llmEventResult(frames(failed), baseIdentity), { wantsStream: false })
  expect(native.status).toBe(200)
  expect(await native.json()).toMatchObject({ status: 'failed', error: { message: 'Policy denied' } })

  const chat = await respondChatCompletions(translatedFixture({ kind: "translated", source: "chat_completions", protocol: "responses" }, frames(failed) as never,
    { ...baseIdentity, translatorPair: { source: 'chat_completions', hub: 'responses' } },
    undefined, undefined,
    async body => translateResponsesToChatBody(body),
  ), { wantsStream: false, includeUsageChunk: false })
  expect(chat.status).toBe(502)
  expect(await chat.json()).toMatchObject({ error: { message: 'Policy denied' } })

  const messages = await respondMessages(translatedFixture({ kind: "translated", source: "messages", protocol: "responses" }, frames(failed) as never,
    { ...baseIdentity, translatorPair: { source: 'messages', hub: 'responses' } },
    undefined, undefined,
    async body => translateResponsesToMessagesBody(body as Parameters<typeof translateResponsesToMessagesBody>[0]),
  ), { wantsStream: false })
  expect(messages.status).toBe(502)
  expect(await messages.json()).toMatchObject({ type: 'error', error: { message: 'Policy denied' } })
})

test('completed refusal remains a successful translated result; token-limit incomplete stays separate', async () => {
  for (const [status, content, expectedChatFinish, expectedMessagesStop] of [
    ['completed', [{ type: 'refusal', refusal: '' }], 'stop', 'refusal'],
    ['incomplete', [{ type: 'output_text', text: 'Partial' }], 'length', 'max_tokens'],
  ] as const) {
    const response = hubResponse(status, [...content])
    const chat = await respondChatCompletions(translatedFixture({ kind: "translated", source: "chat_completions", protocol: "responses" }, frames(response) as never,
      { ...baseIdentity, translatorPair: { source: 'chat_completions', hub: 'responses' } },
      undefined, undefined,
      async body => translateResponsesToChatBody(body),
    ), { wantsStream: false, includeUsageChunk: false })
    expect(chat.status).toBe(200)
    expect(await chat.json()).toMatchObject({ choices: [{ finish_reason: expectedChatFinish }] })

    const messages = await respondMessages(translatedFixture({ kind: "translated", source: "messages", protocol: "responses" }, frames(response) as never,
      { ...baseIdentity, translatorPair: { source: 'messages', hub: 'responses' } },
      undefined, undefined,
      async body => translateResponsesToMessagesBody(body as Parameters<typeof translateResponsesToMessagesBody>[0]),
    ), { wantsStream: false })
    expect(messages.status).toBe(200)
    expect(await messages.json()).toMatchObject({ stop_reason: expectedMessagesStop })
  }
})
