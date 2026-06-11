/**
 * HTTPError — carries an upstream Response so callers can repackage it for
 * the downstream client without losing status code, headers, or raw body.
 *
 * Lifted into @vnext/provider in Phase A Task 2 (X-2) so the
 * UpstreamResponse discriminated union (errors.ts sibling) can reference it
 * without a cycle. @vnext/provider-copilot still re-exports the symbol from
 * its `lib/error.ts` for backward compatibility with existing call-sites.
 */
export class HTTPError extends Error {
  response: Response

  constructor(message: string, response: Response) {
    super(message)
    this.response = response
  }
}
