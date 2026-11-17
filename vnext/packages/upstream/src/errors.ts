/**
 * HTTPError — carries an upstream Response so callers can repackage it for
 * the downstream client without losing status code, headers, or raw body.
 * Lives in @vibe-core/upstream so every adapter surfaces the same error
 * type.
 */
export class HTTPError extends Error {
  response: Response
  /**
   * True when the gateway built this error (and its synthetic 502) because the request never produced an
   * upstream response: a connection failure or timeout. `cause` then holds the original error.
   */
  readonly transport: boolean

  constructor(message: string, response: Response, options?: { transport?: boolean; cause?: unknown }) {
    super(message, options && "cause" in options ? { cause: options.cause } : undefined)
    this.response = response
    this.transport = options?.transport === true
  }
}
