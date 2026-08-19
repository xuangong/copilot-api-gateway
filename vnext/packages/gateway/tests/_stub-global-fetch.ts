/**
 * Shared global-fetch stub for tests that must prove a code path uses an
 * injected fetcher rather than reaching the network. Consumers keep their own
 * `afterEach(() => { globalThis.fetch = realFetch })` so the restore stays
 * per-file and a mid-test throw cannot leak a stub into the next file.
 */

export const realFetch = globalThis.fetch

/** Replace the global fetch with `impl`, keeping the non-call members of the
 *  runtime's fetch (e.g. `preconnect`) so no cast is needed. `impl` may ignore
 *  its arguments, or read the URL when it has to answer several endpoints. */
export function stubGlobalFetch(
  impl: (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>,
): void {
  globalThis.fetch = Object.assign(impl, realFetch)
}
