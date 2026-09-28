export interface MessagesRefusalDetails {
  category?: string | null
  explanation?: string | null
}

export function messagesRefusalExplanation(details?: MessagesRefusalDetails | null): string {
  if (details?.explanation != null) return details.explanation
  return details?.category
    ? `Anthropic refused this request under the ${details.category} policy category.`
    : 'Anthropic refused this request under an unspecified policy category.'
}

export function messagesRefusalResponsesError(details?: MessagesRefusalDetails | null): { code: string; message: string } {
  const explanation = messagesRefusalExplanation(details)
  if (details?.category === 'cyber') return { code: 'cyber_policy', message: explanation }
  if (details?.category === 'bio') {
    const prefix = 'This content was flagged for possible biological risk.'
    return { code: 'bio_policy', message: details.explanation ? `${prefix} ${details.explanation}` : prefix }
  }
  return { code: 'invalid_prompt', message: explanation }
}
