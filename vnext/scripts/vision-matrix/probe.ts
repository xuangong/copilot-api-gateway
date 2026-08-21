/**
 * Request shaping and answer grading for the vision matrix.
 *
 * Kept separate from the runner so the parts that silently rot — the per
 * protocol image block shape and the SSE delta readers — are unit tested. A
 * translator regression should surface here as a failing expectation, not as a
 * matrix run that quietly reports everything green.
 */

import { QUADRANT_COLOURS, type Colour } from './png'

export type Protocol = 'openai' | 'anthropic' | 'gemini' | 'responses'
export const PROTOCOLS: Protocol[] = ['openai', 'anthropic', 'gemini', 'responses']

const COLOUR_RE = /red|green|blue|yellow|purple|orange|black|white/g

/**
 * Strict on purpose: exactly four colours, in order. A model that lists five
 * or trails off after two has not demonstrated it saw the image.
 */
export function grade(answer: string, expect: readonly Colour[]): boolean {
  const found = answer.toLowerCase().match(COLOUR_RE) ?? []
  return found.length === expect.length && found.every((c, i) => c === expect[i])
}

function dataUrl(png: Uint8Array): string {
  return `data:image/png;base64,${Buffer.from(png).toString('base64')}`
}

export interface Built { url: string; headers: Record<string, string>; body: string }

export function buildRequest(
  protocol: Protocol,
  model: string,
  png: Uint8Array,
  prompt: string,
  base: string,
  key: string,
): Built {
  const url = dataUrl(png)
  const b64 = url.slice(url.indexOf(',') + 1)
  const json = { 'content-type': 'application/json' }

  switch (protocol) {
    case 'openai':
      return {
        url: `${base}/v1/chat/completions`,
        headers: { ...json, 'x-api-key': key },
        body: JSON.stringify({
          model, stream: true, max_tokens: MAX_TOKENS,
          messages: [{ role: 'user', content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url } },
          ] }],
        }),
      }
    case 'anthropic':
      return {
        url: `${base}/v1/messages`,
        headers: { ...json, 'x-api-key': key },
        body: JSON.stringify({
          model, stream: true, max_tokens: MAX_TOKENS,
          messages: [{ role: 'user', content: [
            { type: 'text', text: prompt },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64 } },
          ] }],
        }),
      }
    case 'gemini':
      return {
        url: `${base}/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`,
        headers: { ...json, 'x-goog-api-key': key },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [
            { text: prompt },
            { inlineData: { mimeType: 'image/png', data: b64 } },
          ] }],
        }),
      }
    case 'responses':
      return {
        url: `${base}/v1/responses`,
        headers: { ...json, 'x-api-key': key },
        body: JSON.stringify({
          model, stream: true, max_output_tokens: MAX_TOKENS,
          input: [{ type: 'message', role: 'user', content: [
            { type: 'input_text', text: prompt },
            // The url belongs in `image_url`, never `text` — emitting it as
            // `text` is exactly the bug this harness exists to catch.
            { type: 'input_image', image_url: url, detail: 'auto' },
          ] }],
        }),
      }
  }
}

/**
 * Generous: reasoning models spend most of the budget thinking, and a run that
 * truncates mid-answer looks identical to a dropped image.
 */
const MAX_TOKENS = 2000

export function extractText(protocol: Protocol, event: unknown): string {
  const e = event as Record<string, any>
  switch (protocol) {
    case 'openai':
      return e?.choices?.[0]?.delta?.content ?? ''
    case 'anthropic':
      return e?.type === 'content_block_delta' ? e?.delta?.text ?? '' : ''
    case 'gemini':
      return (e?.candidates?.[0]?.content?.parts ?? [])
        .map((p: any) => p?.text ?? '').join('')
    case 'responses':
      return e?.type === 'response.output_text.delta' ? e?.delta ?? '' : ''
  }
}

/** mulberry32 — small, seeded, good enough to make a run reproducible. */
export function seededRng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const ALL = Object.keys(QUADRANT_COLOURS) as Colour[]

/** Four distinct colours — a repeat would let a partly-wrong answer grade right. */
export function pickQuadrants(rng: () => number): [Colour, Colour, Colour, Colour] {
  const pool = [...ALL]
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[pool[i], pool[j]] = [pool[j]!, pool[i]!]
  }
  return pool.slice(0, 4) as [Colour, Colour, Colour, Colour]
}
