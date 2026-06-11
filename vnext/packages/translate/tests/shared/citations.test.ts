import { describe, it, expect } from 'bun:test'
import {
  citationsDeltaToUrlCitation,
  isCitationsDelta,
  blanketDropCitations,
} from '@vnext/translate/shared/citations'

describe('citations', () => {
  describe('isCitationsDelta', () => {
    it('returns true for { type: "citations_delta", citation: {...} }', () => {
      expect(isCitationsDelta({ type: 'citations_delta', citation: { url: 'https://x' } })).toBe(true)
    })
    it('returns false for other delta types', () => {
      expect(isCitationsDelta({ type: 'text_delta', text: 'hi' })).toBe(false)
      expect(isCitationsDelta(null)).toBe(false)
      expect(isCitationsDelta(undefined)).toBe(false)
      expect(isCitationsDelta('citations_delta')).toBe(false)
    })
  })

  describe('citationsDeltaToUrlCitation', () => {
    it('converts a citations_delta into a url_citation annotation', () => {
      const out = citationsDeltaToUrlCitation({
        type: 'citations_delta',
        citation: {
          type: 'web_search_result_location',
          url: 'https://example.com/article',
          title: 'Example Article',
          cited_text: 'a snippet',
          encrypted_index: 'enc-1',
        },
      })
      expect(out).toEqual({
        type: 'url_citation',
        url: 'https://example.com/article',
        title: 'Example Article',
        start_index: undefined,
        end_index: undefined,
      })
    })

    it('preserves start_index/end_index when present', () => {
      const out = citationsDeltaToUrlCitation({
        type: 'citations_delta',
        citation: {
          url: 'https://x',
          title: 'T',
          start_index: 10,
          end_index: 25,
        },
      })
      expect(out).toEqual({
        type: 'url_citation',
        url: 'https://x',
        title: 'T',
        start_index: 10,
        end_index: 25,
      })
    })

    it('returns null when citation is missing url', () => {
      const out = citationsDeltaToUrlCitation({
        type: 'citations_delta',
        citation: { title: 'no url' },
      })
      expect(out).toBeNull()
    })

    it('returns null when input is not a citations_delta', () => {
      const out = citationsDeltaToUrlCitation({ type: 'text_delta', text: 'x' })
      expect(out).toBeNull()
    })
  })

  describe('blanketDropCitations', () => {
    it('returns empty array — chat-via-messages drops all citations (permanent limitation)', () => {
      const events = [
        { type: 'citations_delta', citation: { url: 'a' } },
        { type: 'text_delta', text: 'kept' },
        { type: 'citations_delta', citation: { url: 'b' } },
      ]
      const out = blanketDropCitations(events)
      expect(out).toEqual([{ type: 'text_delta', text: 'kept' }])
    })

    it('passes through when no citations are present', () => {
      const events = [
        { type: 'text_delta', text: 'hello' },
        { type: 'text_delta', text: ' world' },
      ]
      expect(blanketDropCitations(events)).toEqual(events)
    })
  })
})
