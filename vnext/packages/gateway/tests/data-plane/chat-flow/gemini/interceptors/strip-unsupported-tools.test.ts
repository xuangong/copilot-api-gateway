/**
 * The gemini tool-stripping interceptor must let hosted web search through:
 * each `gemini-via-*` request translator now maps `googleSearch` /
 * `googleSearchRetrieval` onto its target's hosted-search shape.
 */
import { describe, it, expect } from 'bun:test'
import { stripUnsupportedToolsFromPayload } from '../../../../../src/data-plane/chat-flow/gemini/interceptors/strip-unsupported-tools'

describe('strip-unsupported-tools', () => {
  it('keeps a search-only tool group alive', () => {
    const payload: Record<string, unknown> = { tools: [{ googleSearch: {} }] }
    stripUnsupportedToolsFromPayload(payload)
    expect(payload.tools).toEqual([{ googleSearch: {} }])
  })

  it('keeps googleSearchRetrieval, the 1.5-era spelling', () => {
    const payload: Record<string, unknown> = { tools: [{ googleSearchRetrieval: {} }] }
    stripUnsupportedToolsFromPayload(payload)
    expect(payload.tools).toEqual([{ googleSearchRetrieval: {} }])
  })

  it('still strips capabilities we cannot translate', () => {
    const payload: Record<string, unknown> = {
      tools: [{ googleSearch: {}, codeExecution: {}, urlContext: {} }, { computerUse: {} }],
    }
    stripUnsupportedToolsFromPayload(payload)
    // Group 1 survives on its googleSearch alone with the rest removed; group 2
    // carried nothing translatable and is dropped entirely.
    expect(payload.tools).toEqual([{ googleSearch: {} }])
  })

  it('keeps function declarations', () => {
    const payload: Record<string, unknown> = {
      tools: [{ functionDeclarations: [{ name: 'f' }], googleMaps: {} }],
    }
    stripUnsupportedToolsFromPayload(payload)
    expect(payload.tools).toEqual([{ functionDeclarations: [{ name: 'f' }] }])
  })

  it('deletes the tools field when nothing survives', () => {
    const payload: Record<string, unknown> = { tools: [{ codeExecution: {} }] }
    stripUnsupportedToolsFromPayload(payload)
    expect('tools' in payload).toBe(false)
  })
})
