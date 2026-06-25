/**
 * HTTPError — carries an upstream Response so callers can repackage it for
 * the downstream client without losing status code, headers, or raw body.
 * Lives in @vibe-core/upstream so every adapter surfaces the same error
 * type.
 */
export class HTTPError extends Error {
  response: Response

  constructor(message: string, response: Response) {
    super(message)
    this.response = response
  }
}
