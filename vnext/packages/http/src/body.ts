/**
 * Body helpers shared across provider transports.
 *
 * parseJsonBody — lifted verbatim from @vnext-llm/provider-copilot/src/provider.ts.
 *   The copilot transport always sends a JSON-string body; non-string bodies
 *   (FormData, ReadableStream, etc.) are a programmer error here. Custom/Azure
 *   providers (plan2/plan3) have FormData branches and call parseJsonBody only
 *   on the JSON paths, matching that contract.
 *
 * truncateBody — extracted from @vnext-llm/provider-copilot/src/forward.ts:85-88.
 *   When an upstream error body isn't valid JSON, we cap it at `max` characters
 *   and append "...(truncated)" so logs/HTTPError messages stay readable.
 *   Default max=200 matches the existing inline behavior.
 */
export function parseJsonBody(
  body: RequestInit['body'] | undefined,
): Record<string, unknown> {
  if (typeof body !== 'string') {
    throw new Error('parseJsonBody: body must be a JSON string')
  }
  return JSON.parse(body) as Record<string, unknown>
}

export function truncateBody(s: string, max = 200): string {
  return s.length > max ? s.slice(0, max) + '...(truncated)' : s
}
