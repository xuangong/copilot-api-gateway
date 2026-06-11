/**
 * HTTPError class — verbatim copy from apps/gateway/src/shared/lib/error.ts.
 *
 * Only the `HTTPError` shape is copied; gateway's `formatErrorResponse`
 * and `isAuthError` stay there because no Copilot data-plane file imports
 * them. Acceptable duplication: the class is structural, not behavioral
 * state, so two copies cannot drift in semantics.
 */
export class HTTPError extends Error {
  response: Response

  constructor(message: string, response: Response) {
    super(message)
    this.response = response
  }
}
