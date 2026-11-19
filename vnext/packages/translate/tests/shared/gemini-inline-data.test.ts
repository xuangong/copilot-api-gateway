/**
 * Adapted from reference copilot-gateway 0d3f98033 (#619): dropping input yields confident wrong
 * answers. Gemini inlineData PDF/audio must reach the target in its native shape, and media the
 * target cannot represent must be rejected instead of silently dropped (or mislabelled as image).
 */
import { describe, it, expect } from 'bun:test'
import { translateGeminiToChat } from '@vibe-llm/translate/gemini-via-chat-completions'
import { translateGeminiToResponses } from '@vibe-llm/translate/gemini-via-responses'
import { translateGeminiToMessages } from '@vibe-llm/translate/gemini-via-messages'
import { TranslatorValidationError } from '../../src/errors.ts'

const inline = (mimeType: string, data: string) => ({ inlineData: { mimeType, data } })
const req = (...parts: unknown[]) => ({ contents: [{ role: 'user', parts }] }) as never
// The signed path (thought/thoughtSignature present) is a separate Gemini->Chat implementation.
const signedReq = (...parts: unknown[]) => ({
  contents: [{ role: 'user', parts }, { role: 'model', parts: [{ text: 'x', thought: true, thoughtSignature: 's' }] }, { role: 'user', parts: [{ text: 'again' }] }],
}) as never

describe('Chat target', () => {
  for (const [name, build] of [['plain', req], ['signed', signedReq]] as const) {
    it(`${name}: maps PDF to a file part and audio to input_audio`, () => {
      const out = translateGeminiToChat(build(
        { text: 'Describe.' }, inline('application/pdf', 'cGRm'), inline('image/png', 'aW1hZ2U='),
        inline('audio/wav', 'd2F2'), inline('audio/mp3', 'bXAz'), inline('audio/mpeg', 'bXBlZw=='),
      ), { model: 'm' } as never) as unknown as { messages: Array<{ role: string; content: unknown }> }
      expect(out.messages.find((m) => m.role === 'user')?.content).toEqual([
        { type: 'text', text: 'Describe.' },
        { type: 'file', file: { file_data: 'data:application/pdf;base64,cGRm' } },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,aW1hZ2U=' } },
        { type: 'input_audio', input_audio: { data: 'd2F2', format: 'wav' } },
        { type: 'input_audio', input_audio: { data: 'bXAz', format: 'mp3' } },
        { type: 'input_audio', input_audio: { data: 'bXBlZw==', format: 'mp3' } },
      ])
    })
    it(`${name}: rejects unsupported inline MIME types`, () => {
      expect(() => translateGeminiToChat(build(inline('text/plain', 'dGV4dA==')), { model: 'm' } as never)).toThrow(TranslatorValidationError)
      expect(() => translateGeminiToChat(build(inline('text/plain', 'dGV4dA==')), { model: 'm' } as never)).toThrow("inlineData MIME type 'text/plain'")
    })
  }
})

describe('Responses target', () => {
  it('maps PDF to input_file', () => {
    const out = translateGeminiToResponses(req(inline('application/pdf', 'cGRm'), inline('image/png', 'aW1hZ2U=')), { model: 'm' } as never) as unknown as { input: Array<{ content: unknown }> }
    expect(out.input[0]?.content).toEqual([
      { type: 'input_file', file_data: 'data:application/pdf;base64,cGRm' },
      { type: 'input_image', image_url: 'data:image/png;base64,aW1hZ2U=', detail: 'auto' },
    ])
  })
  it.each(['audio/wav', 'audio/mp3', 'audio/mpeg', 'text/plain'])('rejects %s', (mimeType) => {
    expect(() => translateGeminiToResponses(req(inline(mimeType, 'ZGF0YQ==')), { model: 'm' } as never)).toThrow(`inlineData MIME type '${mimeType}'`)
  })
})

describe('Messages target', () => {
  for (const [name, build] of [['plain', req], ['signed', signedReq]] as const) {
    it(`${name}: maps PDF to a document block`, () => {
      const out = translateGeminiToMessages(build(inline('application/pdf', 'cGRm')), { model: 'm' } as never) as unknown as { messages: Array<{ role: string; content: Array<{ type: string }> }> }
      expect(out.messages[0]?.content.find((b) => b.type === 'document')).toMatchObject({
        type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'cGRm' },
      })
    })
    it.each(['audio/wav', 'audio/mp3', 'audio/mpeg', 'text/plain'])(`${name}: rejects %s`, (mimeType) => {
      expect(() => translateGeminiToMessages(build(inline(mimeType, 'ZGF0YQ==')), { model: 'm' } as never)).toThrow(`inlineData MIME type '${mimeType}'`)
    })
  }
})
