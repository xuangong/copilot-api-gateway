/**
 * Citation translation utilities.
 *
 * Anthropic Messages emits inline citations as `content_block_delta` events
 * with `delta.type === "citations_delta"`. Each citation carries a URL,
 * title, optional `start_index`/`end_index`, and an opaque `encrypted_index`
 * for round-trip verification.
 *
 * OpenAI Responses emits citations as `url_citation` annotations on
 * `output_text` parts with `{ type, url, title, start_index, end_index }`.
 *
 * Pairs needing this:
 *   - responses-via-messages : citations_delta → url_citation annotation
 *   - chat-completions-via-messages : permanent drop (Chat Completions has no
 *     in-line annotation vocabulary; clients lose this signal by design).
 */

interface CitationsDelta {
  type: 'citations_delta'
  citation: {
    type?: string
    url?: string
    title?: string
    cited_text?: string
    encrypted_index?: string
    start_index?: number
    end_index?: number
  }
}

interface UrlCitationAnnotation {
  type: 'url_citation'
  url: string
  title: string | undefined
  start_index: number | undefined
  end_index: number | undefined
}

export function isCitationsDelta(value: unknown): value is CitationsDelta {
  if (!value || typeof value !== 'object') return false
  const v = value as { type?: unknown; citation?: unknown }
  return v.type === 'citations_delta' && !!v.citation && typeof v.citation === 'object'
}

export function citationsDeltaToUrlCitation(value: unknown): UrlCitationAnnotation | null {
  if (!isCitationsDelta(value)) return null
  const c = value.citation
  if (!c.url) return null
  return {
    type: 'url_citation',
    url: c.url,
    title: c.title,
    start_index: c.start_index,
    end_index: c.end_index,
  }
}

/**
 * Permanent limitation: Chat Completions has no native citation vocabulary.
 * Drop every citations_delta from the event stream; pass everything else
 * through unchanged.
 */
export function blanketDropCitations<T>(events: Iterable<T>): T[] {
  const out: T[] = []
  for (const e of events) {
    if (isCitationsDelta(e)) continue
    out.push(e)
  }
  return out
}
