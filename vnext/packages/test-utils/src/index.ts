/**
 * Shared test infrastructure for vnext packages.
 *
 * Before this package, the same helpers were redefined per test file
 * (`buildApp` 48×, stream readers 49×, `globalThis.fetch =` 89×), each copy
 * drifting slightly — some forgot to restore the global fetch, which leaks a
 * stub into whichever file Bun runs next. Prefer these over local copies.
 */
export { jsonResponse, sseResponse } from "./responses"
export { collect, readBodyText } from "./streams"
export { createFetchStub, recordingFetcher, withMockedFetch, type RecordedRequest } from "./fetch"
export { cassetteAgeDays, recordingCassetteFetcher, replayFetcher, scrubBody, scrubUrl, SCRUBBED, type Cassette, type CassetteInteraction } from "./cassette"
