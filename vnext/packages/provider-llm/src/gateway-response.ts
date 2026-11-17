// Responses a provider builds itself (quota-snapshot 429, credential 503) never reached the upstream.
// The registry is by object identity, so nothing is added to headers or bodies and nothing can leak to a client.
const generated = new WeakSet<object>()

/** Marks a `Response` that the gateway or provider fabricated rather than received from the upstream. */
export function markGatewayResponse<T extends object>(response: T): T {
  generated.add(response)
  return response
}

export const isGatewayResponse = (response: object): boolean => generated.has(response)
