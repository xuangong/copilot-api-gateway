/**
 * HTTPError — carries an upstream Response so callers can repackage it for
 * the downstream client without losing status code, headers, or raw body.
 *
 * Lives in @vnext-llm/provider so every adapter (Copilot, Azure, Custom, SDF)
 * surfaces the same error type. @vnext-llm/provider-copilot still re-exports
 * the symbol from its `lib/error.ts` for backward compatibility with
 * existing call-sites.
 */
export class HTTPError extends Error {
  response: Response

  constructor(message: string, response: Response) {
    super(message)
    this.response = response
  }
}
