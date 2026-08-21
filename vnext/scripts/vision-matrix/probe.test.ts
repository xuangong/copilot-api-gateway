import { describe, expect, it } from 'bun:test'
import { buildRequest, extractText, grade, pickQuadrants, seededRng } from './probe'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
const EXPECT = ['red', 'green', 'blue', 'yellow'] as const

describe('grade', () => {
  it('accepts the four colours in order', () => {
    expect(grade('red, green, blue, yellow', EXPECT)).toBe(true)
  })

  it('ignores surrounding prose and casing', () => {
    expect(grade('Sure! They are Red, GREEN, blue and Yellow.', EXPECT)).toBe(true)
  })

  it('rejects a wrong order', () => {
    expect(grade('red, green, yellow, blue', EXPECT)).toBe(false)
  })

  it('rejects a truncated answer', () => {
    expect(grade('red, green', EXPECT)).toBe(false)
  })

  it('rejects extra colours, which would let a rambling answer pass', () => {
    expect(grade('red, green, blue, yellow, purple', EXPECT)).toBe(false)
  })
})

describe('buildRequest', () => {
  it('sends chat-completions image parts as image_url', () => {
    const r = buildRequest('openai', 'm', PNG, 'p', 'http://h', 'k')
    expect(r.url).toBe('http://h/v1/chat/completions')
    expect(r.headers['x-api-key']).toBe('k')
    const body = JSON.parse(r.body)
    expect(body.messages[0].content[1].type).toBe('image_url')
    expect(body.messages[0].content[1].image_url.url).toStartWith('data:image/png;base64,')
  })

  it('sends messages image blocks as a base64 source', () => {
    const body = JSON.parse(buildRequest('anthropic', 'm', PNG, 'p', 'http://h', 'k').body)
    expect(body.messages[0].content[1]).toMatchObject({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png' },
    })
  })

  it('sends gemini image parts as inlineData and keys off x-goog-api-key', () => {
    const r = buildRequest('gemini', 'm', PNG, 'p', 'http://h', 'k')
    expect(r.url).toContain('/v1beta/models/m:streamGenerateContent')
    expect(r.headers['x-goog-api-key']).toBe('k')
    expect(JSON.parse(r.body).contents[0].parts[1].inlineData.mimeType).toBe('image/png')
  })

  it('sends responses image parts as input_image with the url in image_url', () => {
    const body = JSON.parse(buildRequest('responses', 'm', PNG, 'p', 'http://h', 'k').body)
    const part = body.input[0].content[1]
    expect(part.type).toBe('input_image')
    expect(part.image_url).toStartWith('data:image/png;base64,')
    expect(part.text).toBeUndefined()
  })

  it('url-encodes the model in the gemini path', () => {
    expect(buildRequest('gemini', 'a/b', PNG, 'p', 'http://h', 'k').url).toContain('a%2Fb')
  })
})

describe('extractText', () => {
  it('reads chat-completions deltas', () => {
    expect(extractText('openai', { choices: [{ delta: { content: 'hi' } }] })).toBe('hi')
  })

  it('reads anthropic content_block_delta only', () => {
    expect(extractText('anthropic', { type: 'content_block_delta', delta: { text: 'hi' } })).toBe('hi')
    expect(extractText('anthropic', { type: 'message_start' })).toBe('')
  })

  it('reads gemini candidate parts', () => {
    expect(extractText('gemini', { candidates: [{ content: { parts: [{ text: 'a' }, { text: 'b' }] } }] }))
      .toBe('ab')
  })

  it('reads responses output_text deltas', () => {
    expect(extractText('responses', { type: 'response.output_text.delta', delta: 'hi' })).toBe('hi')
    expect(extractText('responses', { type: 'response.created' })).toBe('')
  })

  it('returns empty for a shape it does not recognise', () => {
    expect(extractText('openai', { ping: true })).toBe('')
  })
})

describe('pickQuadrants', () => {
  it('is reproducible for a given seed', () => {
    expect(pickQuadrants(seededRng(7))).toEqual(pickQuadrants(seededRng(7)))
  })

  it('varies across seeds', () => {
    const runs = [1, 2, 3, 4, 5].map((s) => pickQuadrants(seededRng(s)).join())
    expect(new Set(runs).size).toBeGreaterThan(1)
  })

  it('never repeats a colour, so a wrong answer cannot be graded right by luck', () => {
    for (let s = 0; s < 50; s++) {
      const q = pickQuadrants(seededRng(s))
      expect(new Set(q).size).toBe(4)
    }
  })
})
