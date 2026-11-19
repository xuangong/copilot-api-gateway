import { afterEach } from "bun:test"
import type { Fetcher } from "@vibe-core/upstream"

export interface RecordedRequest {
  url: string
  method: string
  headers: Headers
  body: string
}

async function record(input: RequestInfo | URL, init?: RequestInit): Promise<{ request: Request; recorded: RecordedRequest }> {
  const request = input instanceof Request && init === undefined ? input : new Request(input, init)
  const body = request.body ? await request.clone().text() : ""
  return { request, recorded: { url: request.url, method: request.method, headers: new Headers(request.headers), body } }
}

/**
 * An injectable `Fetcher` that records each request and answers with
 * `respond` (default: empty 200 JSON). For code that takes a fetcher instead
 * of reaching for the global one.
 */
export function recordingFetcher(respond: (request: Request) => Response | Promise<Response> = () => Response.json({})): {
  fetcher: Fetcher
  calls: RecordedRequest[]
} {
  const calls: RecordedRequest[] = []
  const fetcher: Fetcher = async (input, init) => {
    const { request, recorded } = await record(input as RequestInfo, init as RequestInit)
    calls.push(recorded)
    return await respond(request)
  }
  return { fetcher, calls }
}

/**
 * Call once at the top level of a test file; returns a `stubGlobalFetch`
 * that replaces `globalThis.fetch` for the current test and records what
 * reached it. The fetch in place when the file loaded is restored after
 * every test of that file.
 *
 * Per-file on purpose: Bun scopes a top-level `afterEach` to the file that
 * registers it, so a process-wide "registered once" flag would leave every
 * later file without a restore (and a fetch captured at first import could
 * itself be another file's leaked stub). Bun 1.3.0 has no working
 * `onTestFinished` to tie the restore to the stubbing test instead.
 */
export function createFetchStub(): (respond: (request: Request) => Response | Promise<Response>) => { calls: RecordedRequest[] } {
  const original = globalThis.fetch
  afterEach(() => { globalThis.fetch = original })
  return respond => {
    const calls: RecordedRequest[] = []
    globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
      const { request, recorded } = await record(input, init)
      calls.push(recorded)
      return await respond(request)
    }, original)
    return { calls }
  }
}

// Tests in one process share the global fetch slot; the lock serializes
// overlapping withMockedFetch calls so each handler sees only its own requests.
let fetchLock: Promise<void> = Promise.resolve()

/** Run `run` with `globalThis.fetch` answered by `handler`, restoring it afterwards even on failure. */
export async function withMockedFetch<T>(handler: (request: Request) => Response | Promise<Response>, run: () => Promise<T>): Promise<T> {
  let release!: () => void
  const previous = fetchLock
  fetchLock = new Promise<void>(resolve => { release = resolve })
  await previous
  const original = globalThis.fetch
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) =>
    await handler(input instanceof Request && init === undefined ? input : new Request(input, init)), original)
  try {
    return await run()
  } finally {
    globalThis.fetch = original
    release()
  }
}
